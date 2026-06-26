import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (!node) continue;
    const text = node.text.replace(/\s+/g, ' ').trim();

    if (node.type === 'import_statement') {
      // `import a.b.c` / `import a.b as c` / `import a, b`
      const m = text.match(/^import\s+(.+)$/);
      if (!m) continue;
      for (const part of m[1].split(',')) {
        const dotted = part.trim().split(/\s+as\s+/)[0].trim();
        if (dotted) out.push({ module: dotted, importedName: '*' });
      }
      continue;
    }

    // import_from_statement: `from <mod> import <names>`
    const m = text.match(/^from\s+(.+?)\s+import\s+(.+)$/);
    if (!m) continue;
    const mod = m[1].trim();
    const names = m[2].trim().replace(/^\(([\s\S]+)\)$/, '$1').trim();
    if (names === '*') {
      out.push({ module: mod, importedName: '*' });
    } else {
      for (const n of names.split(',')) {
        const name = n.trim().split(/\s+as\s+/)[0].trim();
        if (name) out.push({ module: mod, importedName: name });
      }
    }
  }
  return out;
}

/** Count leading dots in a relative module spec; return { up, rest }. up=1 → current dir; up=2 → parent; ... */
function splitRelative(spec: string): { up: number; rest: string } {
  let up = 0;
  let i = 0;
  while (i < spec.length && spec[i] === '.') { up++; i++; }
  return { up, rest: spec.slice(i) };
}

/** Turn `a.b.c` into `a/b/c`; leave relative dots for the caller to resolve. */
function dottedToPath(dotted: string): string {
  return dotted.replace(/\./g, '/');
}

function resolveImport(importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  const dir = path.posix.dirname(importerPath);

  // Relative spec (starts with '.').
  if (moduleSpec.startsWith('.')) {
    const { up, rest } = splitRelative(moduleSpec);
    let base = dir;
    for (let i = 1; i < up; i++) base = path.posix.dirname(base); // up=1 → current dir; up=2 → parent; ...
    const target = rest ? path.posix.join(base, dottedToPath(rest)) : base;
    for (const c of [`${target}.py`, `${target}/__init__.py`]) if (known.has(c)) return [c];
    if (rest === '' && known.has(`${base}/__init__.py`)) return [`${base}/__init__.py`];
    return [];
  }

  // Absolute dotted import.
  const target = dottedToPath(moduleSpec);
  for (const c of [`${target}.py`, `${target}/__init__.py`]) if (known.has(c)) return [c];
  return [];
}

export const pythonImports: ImportExtractor = { lang: 'py', extractImports, resolveImport };
