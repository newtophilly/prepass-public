/**
 * Unit stubs for config schema defaulting and validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../../src/schemas/config.js';

test('empty config fills in all defaults', () => {
  const config = configSchema.parse({});
  assert.equal(config.version, 1, 'schema version must default, not be required of users');
  assert.equal(config.models.premium, 'claude-opus-5');
  assert.equal(config.routing.confidenceThreshold, 0.4, 'threshold drives the fall-back-to-default path');
  assert.equal(config.telemetry.enabled, true, 'telemetry is local-only, so it defaults on');
});

test('rejects unknown top-level keys (strict)', () => {
  const result = configSchema.safeParse({ nope: true });
  assert.equal(result.success, false, 'unknown keys must be rejected, not silently ignored');
});

test('rejects an out-of-range confidence threshold', () => {
  const result = configSchema.safeParse({ routing: { confidenceThreshold: 5 } });
  assert.equal(result.success, false);
});

// TODO: cover path resolution in config.ts against a temp directory.
