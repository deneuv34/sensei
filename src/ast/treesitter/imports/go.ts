import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['import_declaration'])) {
    if (!node) continue;
    // Every quoted string in the declaration is a package path.
    const matches = [...node.text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const mod of matches) out.push({ module: mod, importedName: '*' });
  }
  return out;
}

/**
 * Resolve a Go import path to every .go file in the repo directory whose posix
 * path is a suffix of the import path (longest match wins; tie-break ascending).
 * This avoids needing go.mod: e.g. `github.com/foo/bar/internal/auth` matches
 * `internal/auth`. Deterministic.
 */
function resolveImport(_importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  const importSegs = moduleSpec.split('/');
  const candidates: string[] = [];
  // Try progressively shorter suffixes of the import path as a directory.
  for (let start = 0; start < importSegs.length; start++) {
    const dirPrefix = importSegs.slice(start).join('/') + '/';
    const hits = [...known].filter((p) => p.startsWith(dirPrefix) && p.endsWith('.go'));
    if (hits.length) {
      candidates.push(...hits);
      break; // longest matching suffix wins
    }
  }
  // Single-segment import like "errors" → match `errors.go` directly too.
  if (candidates.length === 0) {
    const direct = `${moduleSpec}.go`;
    if (known.has(direct)) return [direct];
  }
  return [...new Set(candidates)].sort();
}

export const goImports: ImportExtractor = { lang: 'go', extractImports, resolveImport };
