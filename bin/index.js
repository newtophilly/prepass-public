#!/usr/bin/env node
/**
 * Global CLI launcher for `prepass`.
 *
 * This is intentionally a tiny shim: it loads the compiled CLI from `dist/`
 * (build with `npm run build`) and hands off. Keeping the shim in plain JS means
 * the published bin has zero transpile step at runtime.
 */
import { main } from '../dist/cli/index.js';

main(process.argv).catch((err) => {
  process.stderr.write(`prepass: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
