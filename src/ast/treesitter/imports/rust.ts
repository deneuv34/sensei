import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['use_declaration'])) {
    if (!node) continue;
    const text = node.text.replace(/\s+/g, ' ').trim();
    const m = text.match(/^use\s+(.+?);$/);
    if (!m) continue;
    let spec = m[1].trim();
    if (spec.endsWith('::*')) {
      spec = spec.slice(0, -3); // `crate::auth::token::*` -> `crate::auth::token`
    }
    out.push({ module: spec, importedName: '*' });
  }
  // `mod foo;` declares a file dependency on `foo.rs` / `foo/mod.rs`.
  // Encode as a synthetic module prefix so the resolver knows it's a mod decl.
  // Note: the grammar names this node `mod_item` (not `mod_declaration`).
  for (const node of root.descendantsOfType(['mod_item'])) {
    if (!node) continue;
    const text = node.text.replace(/\s+/g, ' ').trim();
    const m = text.match(/^mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|\{)/);
    if (!m) continue;
    // Skip inline `mod foo { ... }` bodies (no file edge).
    if (text.includes('{')) continue;
    out.push({ module: `mod:${m[1]}`, importedName: '*' });
  }
  return out;
}

function segsToPath(segs: string[]): string {
  return segs.join('/');
}

function resolveImport(importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  const dir = path.posix.dirname(importerPath);

  // `mod:foo` — a mod declaration relative to the importer's directory.
  if (moduleSpec.startsWith('mod:')) {
    const name = moduleSpec.slice(4);
    const base = path.posix.join(dir, name);
    for (const c of [`${base}.rs`, `${base}/mod.rs`]) if (known.has(c)) return [c];
    return [];
  }

  // `use` spec — strip leading crate-relative / super / self prefix.
  // Assumption: `crate::` maps to the repo `src/` directory (the conventional
  // Cargo layout). Projects using a non-standard layout may need adjustment.
  let segs = moduleSpec.split('::');
  let baseDir = dir;
  if (segs[0] === 'crate') {
    baseDir = 'src';
    segs = segs.slice(1);
  } else if (segs[0] === 'super') {
    baseDir = path.posix.dirname(dir);
    segs = segs.slice(1);
  } else if (segs[0] === 'self') {
    segs = segs.slice(1);
  } else if (segs[0] === 'std' || segs[0] === 'core' || segs[0] === 'alloc') {
    return []; // external stdlib
  }

  const target = path.posix.join(baseDir, segsToPath(segs));
  // Try: full path as file, full path as dir/mod.rs, then drop the last seg
  // (the imported name may be an item, not a module).
  const candidates = [
    `${target}.rs`,
    `${target}/mod.rs`,
    segs.length > 1 ? `${path.posix.join(baseDir, segsToPath(segs.slice(0, -1)))}.rs` : '',
    segs.length > 1 ? `${path.posix.join(baseDir, segsToPath(segs.slice(0, -1)))}/mod.rs` : '',
  ];
  for (const c of candidates) if (c && known.has(c)) return [c];
  return [];
}

export const rustImports: ImportExtractor = { lang: 'rust', extractImports, resolveImport };
