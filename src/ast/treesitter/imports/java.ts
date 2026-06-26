import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['import_declaration'])) {
    if (!node) continue;
    const text = node.text.replace(/\s+/g, ' ').trim();
    // `import [static] <path>;` / `import <path>.*;`
    const m = text.match(/^import\s+(?:static\s+)?([^;]+);$/);
    if (!m) continue;
    const spec = m[1].trim();
    if (spec.endsWith('.*')) {
      out.push({ module: spec.slice(0, -2), importedName: '*' });
    } else {
      const segs = spec.split('.');
      out.push({ module: spec, importedName: segs[segs.length - 1] });
    }
  }
  return out;
}

function resolveImport(_importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  const dotted = moduleSpec.replace(/\./g, '/');
  // External stdlib / non-repo packages.
  if (moduleSpec.startsWith('java.') || moduleSpec.startsWith('javax.') || moduleSpec.startsWith('org.w3c.')) {
    return [];
  }
  // Class import → single file.
  const direct = `${dotted}.java`;
  if (known.has(direct)) return [direct];
  // A class import whose file isn't in the repo should NOT fall through to dir
  // matching (Java classes are PascalCase; packages are lowercase by convention).
  // Only lowercase-last-segment specs (wildcard/package imports with the `.*`
  // stripped by extractImports) legitimately map to a directory.
  const lastSeg = moduleSpec.split('.').pop() ?? '';
  if (lastSeg && lastSeg[0] >= 'A' && lastSeg[0] <= 'Z') return [];
  // Wildcard / package import → every .java file in the package dir.
  const dirPrefix = `${dotted}/`;
  const hits = [...known].filter((p) => p.startsWith(dirPrefix) && p.endsWith('.java')).sort();
  if (hits.length) return hits;
  return [];
}

export const javaImports: ImportExtractor = { lang: 'java', extractImports, resolveImport };
