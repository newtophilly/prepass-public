/**
 * File discovery: build the candidate pool that the curator ranks.
 *
 * Without this stage the curator is a filter with no input — it can only rank
 * files someone already named, which in hook mode is just the single file the
 * tool call was already about to touch. Discovery is what gives curation
 * something to actually curate.
 *
 * Two strategies, in order:
 *   1. `git ls-files` — tracked plus untracked-but-not-ignored. Delegates
 *      ignore semantics to git itself, so `.gitignore`, nested ignores,
 *      negations and `core.excludesFile` are all honored exactly, for free.
 *   2. A bounded manual walk, for directories that aren't git repositories.
 *
 * Both paths are bounded: the walk never descends into known-heavy directories,
 * files above `maxFileBytes` are dropped (they crowd out the token budget), and
 * the result is capped at `maxFiles`. This runs inside a PreToolUse hook, where
 * latency is charged directly to the user's tool call.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ContextCandidate } from '../types.js';
import type { SmartConfig } from '../schemas/config.js';
import { log } from './telemetry.js';

/** Directories never worth walking. Only used by the non-git fallback. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-test',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'coverage',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'Pods',
  'DerivedData',
]);

/**
 * Extensions that are never useful as prompt context. Dropping them here keeps
 * binary blobs from consuming the candidate cap before scoring even runs.
 */
const SKIP_EXTENSIONS = new Set([
  // images / media
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'psd', 'svgz',
  'mp3', 'mp4', 'wav', 'mov', 'avi', 'webm', 'm4a', 'ogg', 'flac',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // archives / binaries
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'node', 'wasm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // build artifacts / data blobs
  'map', 'lock', 'db', 'sqlite', 'sqlite3', 'pyc', 'class',
  // NOT skipped, though it looks like it should be: `.po`/`.mo` translation
  // catalogues are 34% of Django's tree and are never the fix. Excluding them
  // measured *worse* on SWE-bench — MRR 0.383 → 0.347 — because dropping 2,285
  // files shifts every corpus statistic that IDF is computed from. Junk in the
  // pool is not the same as junk in the results, and the ranker was already
  // ignoring them. Don't re-add without re-measuring.
  'ico', 'icns', 'pak', 'dmg', 'iso',
]);

export interface ScanResult {
  readonly candidates: ContextCandidate[];
  /** How the pool was built — useful in logs when results look wrong. */
  readonly source: 'git' | 'walk';
  /** True when the cap was hit, so the pool is a subset of the repo. */
  readonly truncated: boolean;
}

/**
 * Discover candidate files under `rootDir`.
 *
 * Never throws: discovery failing should degrade to an empty pool (the caller
 * still has explicit candidates) rather than break the user's tool call.
 */
export function scanRepo(rootDir: string, config: SmartConfig): ScanResult {
  const { maxFiles, maxFileBytes } = config.discovery;

  let paths: string[] | null = gitLsFiles(rootDir);
  const source: ScanResult['source'] = paths ? 'git' : 'walk';
  if (!paths) paths = walk(rootDir, maxFiles * 4);

  const candidates: ContextCandidate[] = [];
  let truncated = false;

  for (const rel of paths) {
    if (candidates.length >= maxFiles) {
      truncated = true;
      break;
    }
    if (isSkippableExtension(rel)) continue;

    let bytes: number;
    let mtimeMs: number;
    try {
      const st = statSync(join(rootDir, rel));
      if (!st.isFile()) continue;
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // raced deletion, broken symlink, permissions
    }
    if (bytes === 0 || bytes > maxFileBytes) continue;

    // Score is a neutral prior; the curator's heuristic stage does the ranking.
    candidates.push({ path: rel, bytes, score: 0, mtimeMs });
  }

  log('debug', 'scanner.done', {
    source,
    scanned: paths.length,
    kept: candidates.length,
    truncated,
  });

  return { candidates, source, truncated };
}

/**
 * Tracked + untracked-but-not-ignored paths, straight from git. Returns null
 * when this isn't a git repo or git isn't available, so the caller can fall
 * back to walking.
 */
function gitLsFiles(rootDir: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', rootDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    );
    const paths = out.split('\0').filter(Boolean);
    // A git repo with zero files is indistinguishable from a non-repo here;
    // either way walking gains us nothing, so treat it as a valid empty pool.
    return paths;
  } catch {
    return null;
  }
}

/** Bounded breadth-first walk for non-git directories. */
function walk(rootDir: string, hardCap: number): string[] {
  const found: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && found.length < hardCap) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.claude') {
        if (entry.isDirectory()) continue; // .git, .cache, dotfile dirs
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
      } else if (entry.isFile()) {
        found.push(relative(rootDir, full));
        if (found.length >= hardCap) break;
      }
    }
  }
  return found;
}

function isSkippableExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dotfile like `.env`
  const ext = base.slice(dot + 1).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  // Minified bundles are technically text but never useful as context.
  return base.endsWith('.min.js') || base.endsWith('.min.css');
}

/**
 * Merge explicitly-named candidates with discovered ones.
 *
 * Explicit entries win on collision and keep their prior score: a file the
 * caller named (the target of the tool call, or a `--file` flag) is known to be
 * relevant, whereas a discovered file is only a possibility.
 */
export function mergeCandidates(
  explicit: readonly ContextCandidate[],
  discovered: readonly ContextCandidate[],
): ContextCandidate[] {
  const byPath = new Map<string, ContextCandidate>();
  for (const c of discovered) byPath.set(normalize(c.path), c);
  for (const c of explicit) {
    const key = normalize(c.path);
    const found = byPath.get(key);
    // Keep the explicit prior, but adopt the real size if discovery found it.
    byPath.set(key, found ? { ...c, bytes: c.bytes || found.bytes } : c);
  }
  return [...byPath.values()];
}

function normalize(p: string): string {
  return p.replace(/^\.\//, '');
}
