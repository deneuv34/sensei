import { createRequire } from 'node:module';
import type { Ignore } from 'ignore';

// `ignore` ships CJS (module.exports = factory) with a .d.ts that NodeNext types as a
// non-callable default. Load it via createRequire so the runtime value is the real factory.
const require = createRequire(import.meta.url);
const createIgnore = require('ignore') as (options?: object) => Ignore;

/**
 * Return the first gitignore-style pattern in `patterns` that matches
 * `filePath` (repo-relative, posix), or null if none match.
 * Patterns are tested individually so the matched pattern can be reported.
 */
export function firstDangerousMatch(filePath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (createIgnore().add(pattern).ignores(filePath)) return pattern;
  }
  return null;
}
