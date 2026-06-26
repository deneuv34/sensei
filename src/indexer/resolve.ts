import path from 'node:path';
import { langOfPath } from '../lang.js';
import { importExtractors } from '../ast/treesitter/imports/index.js';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

/** Resolve a TS/JS relative specifier. Returns 0 or 1 path. */
function resolveTs(importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  if (!moduleSpec.startsWith('.')) return []; // external package
  const joined = path.posix.join(path.posix.dirname(importerPath), moduleSpec);
  const stripped = joined.replace(/\.(ts|tsx|js|jsx)$/, ''); // map ./x.js specifier -> ./x source
  const candidates = [
    joined,
    ...TS_EXTS.map((e) => stripped + e),
    ...TS_EXTS.map((e) => stripped + '/index' + e),
  ];
  for (const c of candidates) if (known.has(c)) return [c];
  return [];
}

/** Resolve any import specifier to 0..N repo-relative file paths. */
export function resolveImports(importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  const lang = langOfPath(importerPath);
  const extractor = importExtractors[lang];
  if (extractor) return extractor.resolveImport(importerPath, moduleSpec, known);
  return resolveTs(importerPath, moduleSpec, known);
}
