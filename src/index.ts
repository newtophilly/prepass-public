/**
 * Public package entrypoint. Re-exports the stable surface so `prepass`
 * can be consumed as a library, not only as a CLI.
 */
export * from './types.js';
export { loadConfig, findConfigFile, ConfigError, CONFIG_FILENAME } from './config.js';
export { configSchema, type SmartConfig } from './schemas/config.js';
export { detectIntent, loadTaxonomies } from './core/intent-detector.js';
// `model-router` is intentionally NOT exported. It computes an advisory tier
// that feeds telemetry only: a hook cannot switch models, so exposing this as
// public API would invite callers to depend on a decision nothing acts on.
// Kept internal rather than deleted — it is the groundwork for delegation work
// that is deliberately on hold, and it costs nothing where it sits.
export { curate, buildXmlPayload, matchesGlobs } from './core/context-curator.js';
export { estimateTokens } from './tokens.js';
export { Telemetry, log } from './core/telemetry.js';
export { runPipeline, type PipelineInput, type PipelineOutput } from './pipeline.js';
