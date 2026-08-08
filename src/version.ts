/**
 * The running version, read from `package.json`.
 *
 * It was hardcoded once, so `npm version patch` bumped the package while the
 * CLI kept reporting the previous number — drift nobody notices until a bug
 * report cites a version that was never shipped.
 *
 * Resolution walks **up** rather than using a fixed `../package.json`, because
 * this module is compiled to two different depths: `dist/version.js` for the
 * shipped package and `dist-test/src/version.js` for the test build. A fixed
 * relative path is correct in exactly one of them, which is how the first
 * attempt broke two integration suites.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      // Only trust the package that is actually this one — a walk upward can
      // otherwise land on a consumer's package.json when installed as a dep.
      if (pkg.version && (!pkg.name || pkg.name.endsWith('prepass'))) return pkg.version;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Never throw over a version string; a wrong banner beats a dead hook.
  return '0.0.0-unknown';
}

export const VERSION: string = findVersion();
