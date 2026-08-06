/**
 * Telemetry: structured stderr logging + optional SQLite event store.
 *
 * Two independent concerns live here on purpose:
 *   1. `log()` — a zero-dependency structured logger (JSON lines to stderr).
 *      Safe to call from anywhere, including before config is loaded.
 *   2. `Telemetry` — a SQLite-backed aggregator (WAL mode) for per-invocation
 *      metrics. Every method degrades to a no-op if the DB can't be opened, so
 *      telemetry failures never take down a real request.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { TelemetryEvent, Workload } from '../types.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured logger. Writes one JSON object per line to stderr so it never
 * pollutes stdout (which carries the curated payload in proxy mode).
 * Honors PREPASS_LOG=debug|info|warn|error.
 *
 * The default is `warn`, not `info`, because this is a user-facing CLI: at
 * `info` every single command opened with a line of raw JSON about config
 * resolution, so a first run looked like something had gone wrong. Warnings and
 * errors still surface — those a user needs. Set `PREPASS_LOG=info` (or
 * `debug`) to get the running commentary back when diagnosing.
 */
export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  const threshold = LEVELS[(process.env.PREPASS_LOG as LogLevel) ?? 'warn'] ?? LEVELS.warn;
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: Date.now(), level, event, ...data });
  process.stderr.write(line + '\n');
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Drop a self-ignoring `.gitignore` into our own state directory.
 *
 * The telemetry DB lands inside whatever project the hook runs in. Without
 * this, a new user's very first prepass run puts an untracked binary
 * `.db` (plus WAL sidecars) into `git status` — a tool that dirties your repo
 * before it has proved itself is a tool you uninstall. Ignoring ourselves from
 * inside the directory needs no cooperation from the host project's
 * `.gitignore`, which we have no business editing.
 */
function selfIgnore(dir: string): void {
  const marker = join(dir, '.gitignore');
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, '# Created by prepass. Local state; never committed.\n*\n');
  } catch {
    // Best effort: a read-only directory is not a reason to fail a request.
  }
}

export interface TelemetrySummary {
  readonly totalEvents: number;
  readonly byWorkload: Readonly<Record<Workload, number>>;
  readonly escalationRate: number;
  readonly avgLatencyMs: number;
  readonly avgEstimatedTokens: number;
  readonly degradedRate: number;
}

export class Telemetry {
  private db: Database.Database | null = null;

  private constructor(db: Database.Database | null) {
    this.db = db;
  }

  /**
   * Open (and lazily create) the telemetry DB with WAL mode enabled.
   * `better-sqlite3` is loaded dynamically so environments that never enable
   * telemetry don't pay for the native module at import time.
   */
  static async open(dbPath: string, enabled: boolean): Promise<Telemetry> {
    if (!enabled) return new Telemetry(null);
    try {
      const { default: DatabaseCtor } = await import('better-sqlite3');
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true });
      selfIgnore(dir);
      const db = new DatabaseCtor(dbPath);
      // WAL: concurrent readers + a single writer, and durable across crashes —
      // the right tradeoff for a local, append-heavy metrics store.
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.exec(SCHEMA_SQL);
      return new Telemetry(db);
    } catch (err) {
      // A telemetry failure must never break the tool; log and no-op.
      log('warn', 'telemetry.open_failed', { dbPath, error: String(err) });
      return new Telemetry(null);
    }
  }

  record(event: TelemetryEvent): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO events
             (ts, entrypoint, workload, confidence, tier, model_id, escalated,
              curation_stage, estimated_tokens, latency_ms, degraded)
           VALUES (@ts, @entrypoint, @workload, @confidence, @tier, @modelId,
              @escalated, @curationStage, @estimatedTokens, @latencyMs, @degraded)`,
        )
        .run({
          ...event,
          escalated: event.escalated ? 1 : 0,
          degraded: event.degraded ?? null,
        });
    } catch (err) {
      log('warn', 'telemetry.record_failed', { error: String(err) });
    }
  }

  /** Aggregate stored events into a summary for the `stats` command. */
  aggregate(): TelemetrySummary {
    const empty: TelemetrySummary = {
      totalEvents: 0,
      byWorkload: { bugfix: 0, feature: 0, refactor: 0, search: 0, review: 0 },
      escalationRate: 0,
      avgLatencyMs: 0,
      avgEstimatedTokens: 0,
      degradedRate: 0,
    };
    if (!this.db) return empty;

    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                AVG(latency_ms) AS lat,
                AVG(estimated_tokens) AS tok,
                AVG(escalated) AS esc,
                AVG(CASE WHEN degraded IS NOT NULL THEN 1 ELSE 0 END) AS deg
           FROM events`,
      )
      .get() as { n: number; lat: number | null; tok: number | null; esc: number | null; deg: number | null };

    if (!totals.n) return empty;

    const byWorkload = { ...empty.byWorkload };
    for (const row of this.db
      .prepare(`SELECT workload, COUNT(*) AS n FROM events GROUP BY workload`)
      .all() as Array<{ workload: Workload; n: number }>) {
      byWorkload[row.workload] = row.n;
    }

    return {
      totalEvents: totals.n,
      byWorkload,
      escalationRate: totals.esc ?? 0,
      avgLatencyMs: totals.lat ?? 0,
      avgEstimatedTokens: totals.tok ?? 0,
      degradedRate: totals.deg ?? 0,
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  entrypoint       TEXT    NOT NULL,
  workload         TEXT    NOT NULL,
  confidence       REAL    NOT NULL,
  tier             TEXT    NOT NULL,
  model_id         TEXT    NOT NULL,
  escalated        INTEGER NOT NULL,
  curation_stage   TEXT    NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  latency_ms       INTEGER NOT NULL,
  degraded         TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_workload ON events (workload);
`;
