import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const decl of root.descendantsOfType(['import_declaration'])) {
    if (!decl) continue;
    for (const spec of decl.descendantsOfType(['import_spec'])) {
      if (!spec) continue;
      const str = spec.childForFieldName('path') ?? spec.descendantsOfType(['interpreted_string_literal'])[0];
      if (!str) continue;
      const mod = str.text.slice(1, -1); // strip surrounding quotes
      // Go import aliases (e.g. `foo "github.com/x/y"`) rename the package at use-site;
      // use-site resolution is out of scope for the static import graph, so we record the
      // package path only and leave importedName as '*'. The alias is not captured.
      out.push({ module: mod, importedName: '*' });
    }
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
  // Directory-suffix match only for multi-segment paths. Single-segment names like
  // "errors" or "fmt" are stdlib; matching them to a repo `errors/` dir would over-match.
  // Single-segment repo files (e.g. `errors.go`) are still caught by the direct fallback.
  for (let start = 0; start + 1 < importSegs.length; start++) {
    const dirPrefix = importSegs.slice(start).join('/') + '/';
    const hits = [...known].filter((p) => p.startsWith(dirPrefix) && p.endsWith('.go'));
    if (hits.length) {
      candidates.push(...hits);
      break; // longest matching suffix wins
    }
  }
  // Direct file match (covers single-segment stdlib-as-repo-file and last-resort fallback).
  const direct = `${moduleSpec}.go`;
  if (known.has(direct)) candidates.push(direct);
  return [...new Set(candidates)].sort();
}

export const goImports: ImportExtractor = { lang: 'go', extractImports, resolveImport };
