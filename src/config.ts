/**
 * Config loader: finds, reads, and validates `.prepass.json`.
 *
 * Every path in the returned config is resolved to an absolute path against the
 * directory the config file lives in, so downstream modules never have to guess
 * a base directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { configSchema, type SmartConfig } from './schemas/config.js';
import { log } from './core/telemetry.js';

export const CONFIG_FILENAME = '.prepass.json';

export interface LoadedConfig {
  readonly config: SmartConfig;
  /** Directory the config was found in; the base for all relative paths. */
  readonly rootDir: string;
  /** Absolute path to the config file, or null when defaults were used. */
  readonly configPath: string | null;
}

export class ConfigError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Walk up from `startDir` looking for `.prepass.json`.
 * Returns the first match, or null if none is found before the filesystem root.
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  // Bounded by the filesystem root; `dirname('/')` === '/', so we stop there.
  for (;;) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load and validate config. When no file is found we return schema defaults so
 * the tool still works out-of-the-box — graceful degradation over hard failure.
 */
export function loadConfig(startDir: string = process.cwd()): LoadedConfig {
  const configPath = findConfigFile(startDir);

  if (!configPath) {
    log('info', 'config.default', { reason: 'no config file found', startDir });
    return {
      config: configSchema.parse({}),
      rootDir: resolve(startDir),
      configPath: null,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse ${configPath}: not valid JSON`, err);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    // Flatten Zod issues into one human-readable message for the CLI.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid ${CONFIG_FILENAME}:\n${issues}`);
  }

  const rootDir = dirname(configPath);
  return {
    config: resolvePaths(parsed.data, rootDir),
    rootDir,
    configPath,
  };
}

/** Resolve every path-bearing field to an absolute path against `rootDir`. */
function resolvePaths(config: SmartConfig, rootDir: string): SmartConfig {
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(rootDir, p));
  return {
    ...config,
    telemetry: { ...config.telemetry, dbPath: abs(config.telemetry.dbPath) },
    taxonomies: {
      ...config.taxonomies,
      dir: abs(config.taxonomies.dir),
      custom: config.taxonomies.custom.map(abs),
    },
  };
}
