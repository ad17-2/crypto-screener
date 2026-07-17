import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// An extensionless relative import in src compiles into dist untouched, passes vitest/tsx/Next
// (bundler-style resolution), then kills the api at boot under node's strict ESM resolver
// (ERR_MODULE_NOT_FOUND) -- the 2026-07-17 prod crash. Import the built package from a real node
// process so node's resolver, not vitest's, does the resolving. `npm test` builds contracts
// before vitest runs, so dist/ is always present here.
const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('built package', () => {
  it('imports under real node ESM resolution', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(distEntry)}); if (!m.DashboardRowSchema) throw new Error('missing export'); console.log('ok');`,
      ],
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe('ok');
  });
});
