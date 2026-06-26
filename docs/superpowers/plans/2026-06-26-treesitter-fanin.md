# Tree-sitter Fan-in Danger Detection (`0.11.0`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring high-fan-in "do not touch" detection to Python, Go, Rust, and Java, so `context` / `validate-diff` / `validate-plan` flag load-bearing files in every supported language — closing the gap that `0.11.0` is named for.

**Architecture:** Hybrid, per the 2026-06-26 roadmap decision. One shared edge format (the existing `ExtractedImport` + `imports` table + `recomputeImporterCounts` analyzer) feeds the **unchanged** fan-in consumers. Each Tree-sitter language gets its own **extractor module** that walks the parsed tree directly (not a `LangSpec` query) and normalizes its import semantics into `ExtractedImport[]`. A per-language **resolver** maps each `module` specifier to one or more repo-relative file paths. `index-repo.ts`'s resolution step dispatches by language; for package-level imports (Go, Java `*`), one import edge resolves to multiple files via row cloning. The fan-in analyzer, scorer, and all downstream consumers are not modified.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `web-tree-sitter`, `better-sqlite3`, Vitest.

---

## Reference: existing facts (verified against current code)

- `ExtractedImport = { module: string; importedName: string }` — `src/types.ts:23-26`. The shared edge format; **unchanged**.
- `extractTreeSitter(lang, source): FileExtraction` — `src/ast/treesitter/extract.ts:19-39`. Currently returns `imports: []` hardcoded (line 38). This is the seam Task 1 changes.
- `resolveModule(importerPath, moduleSpec, known): string | null` — `src/indexer/index-repo.ts:18-29`. TS/JS-only (relative `.` specifiers, TS extensions). Resolution loop at `:70-78`.
- `IndexDb.allImports()` — `src/indexer/db.ts:151-155` — returns `{ id, file_id, file_path, module }` (no `imported_name`). `insertImport(fileId, imp)` — `:145-149`. `setImportResolution(importId, resolvedFileId)` — `:157-159`. `recomputeImporterCounts()` — `:161-167` (unchanged; counts `DISTINCT i.file_id` per `resolved_file_id`).
- Fan-in consumers (all unchanged by this plan): `findDangerousFiles` — `src/scorer/score.ts:95-106`; `dangerousFindings` — `src/validate/checks.ts:46-66`; `dangerousTargetCheck` — `src/validate/plan-checks.ts:71-95`.
- `LangSpec` registry — `src/ast/treesitter/registry.ts` (symbols only; this plan does not touch it).
- Tests use `vitest` (`describe/it/expect`), tmp dirs via `fs.mkdtempSync`, `simple-git` for e2e, `.js` specifiers in imports. Existing tree-sitter tests warm grammars in `beforeAll`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/ast/treesitter/imports/spec.ts` (create) | `ImportExtractor` interface: `extractImports(root, source)` + `resolveImport(importerPath, moduleSpec, known): string[]`. |
| `src/ast/treesitter/imports/index.ts` (create) | `importExtractors: Partial<Record<Lang, ImportExtractor>>` registry. Starts empty; each language task adds one. |
| `src/ast/treesitter/imports/{python,go,rust,java}.ts` (create) | One `ImportExtractor` per language. Walks the tree to find import statements, parses statement text for `module`/`importedName`, resolves specifiers to repo paths. |
| `src/indexer/resolve.ts` (create) | `resolveImports(importerPath, moduleSpec, known): string[]` — dispatches by lang: TS/JS → existing relative-specifier logic (returns 1 or 0); tree-sitter → `importExtractors[lang].resolveImport`. |
| `src/indexer/db.ts` (modify) | Extend `allImports()` to include `imported_name`; add `insertResolvedImport(fileId, module, importedName, resolvedFileId)` for multi-target row cloning. |
| `src/indexer/index-repo.ts` (modify) | Remove local `resolveModule`; use `resolveImports`; update resolution loop to handle multi-target (set first on existing row, clone for the rest). |
| `src/ast/treesitter/extract.ts` (modify) | Call `importExtractors[lang]?.extractImports(tree.rootNode, source) ?? []` instead of hardcoded `[]`. |
| `test/indexer-resolve.test.ts` (create) | Unit tests for `resolveImports` dispatch + TS regression. |
| `test/treesitter-imports-{python,go,rust,java}.test.ts` (create) | Per-language extractor + resolver unit tests. |
| `test/fanin-e2e.test.ts` (create) | Cross-language fan-in e2e: high-fan-in file flagged by `context` + `validate-diff`. |
| `test/fixtures/fanin-repo/` (create) | Fixture repo with importers per language. |
| `README.md` (modify) | Languages table: flip Dangerous-by-fan-in to ✅ for Tree-sitter langs. |
| `CHANGELOG.md` (modify) | `0.11.0` entry. |
| `package.json` (modify) | Bump version to `0.11.0`. |
| `docs/superpowers/specs/2026-06-20-sensei-roadmap.md` (modify) | Move `0.11.0` into §1 shipped; close §2 gap #1. |

---

## Task 1: Shared `ImportExtractor` interface, resolver dispatch, DB helpers (no behavior change)

Registry starts empty, so every Tree-sitter lang still extracts `imports: []` and resolves nothing. TS/JS behavior is identical. This task is pure scaffolding + refactor.

**Files:**
- Create: `src/ast/treesitter/imports/spec.ts`
- Create: `src/ast/treesitter/imports/index.ts`
- Create: `src/indexer/resolve.ts`
- Modify: `src/indexer/db.ts:145-155`
- Modify: `src/indexer/index-repo.ts:1-83`
- Modify: `src/ast/treesitter/extract.ts:19-39`
- Test: `test/indexer-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/indexer-resolve.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { resolveImports } from '../src/indexer/resolve.js';

describe('resolveImports', () => {
  const known = new Set(['src/util.ts', 'src/util/index.ts', 'src/index.ts']);

  it('resolves a relative TS specifier to a file', () => {
    expect(resolveImports('src/mod.ts', './util', known)).toEqual(['src/util.ts']);
  });

  it('resolves a TS barrel import to index.ts', () => {
    expect(resolveImports('src/mod.ts', './util/index', known)).toEqual(['src/util/index.ts']);
  });

  it('returns [] for an external TS package', () => {
    expect(resolveImports('src/mod.ts', 'react', known)).toEqual([]);
  });

  it('returns [] for a tree-sitter lang with no extractor registered', () => {
    expect(resolveImports('src/mod.py', 'util', known)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/indexer-resolve.test.ts`
Expected: FAIL — cannot find module `../src/indexer/resolve.js`.

- [ ] **Step 3: Create the `ImportExtractor` interface**

Create `src/ast/treesitter/imports/spec.ts`:
```ts
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport, Lang } from '../../../types.js';

export interface ImportExtractor {
  lang: Lang;
  /** Walk the parsed root node and return import edges in the shared format. */
  extractImports(root: Node, source: string): ExtractedImport[];
  /** Resolve a module specifier to 0, 1, or many repo-relative file paths. */
  resolveImport(importerPath: string, moduleSpec: string, known: Set<string>): string[];
}
```

- [ ] **Step 4: Create the empty registry**

Create `src/ast/treesitter/imports/index.ts`:
```ts
import type { Lang } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {};
```

- [ ] **Step 5: Create `src/indexer/resolve.ts`**

Create `src/indexer/resolve.ts`:
```ts
import path from 'node:path';
import { langOfPath } from '../lang.js';
import { importExtractors } from '../ast/treesitter/imports/index.js';

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

/** Resolve a TS/JS relative specifier. Returns 0 or 1 path. */
function resolveTs(importerPath: string, moduleSpec: string, known: Set<string>): string[] {
  if (!moduleSpec.startsWith('.')) return []; // external package
  const joined = path.posix.join(path.posix.dirname(importerPath), moduleSpec);
  const stripped = joined.replace(/\.(ts|tsx|js|jsx)$/, '');
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
```

- [ ] **Step 6: Extend `IndexDb` with `imported_name` in `allImports()` + add `insertResolvedImport`**

In `src/indexer/db.ts`, replace `allImports()` (lines 151-155):
```ts
  allImports(): Array<{ id: number; file_id: number; file_path: string; module: string; imported_name: string }> {
    return this.raw
      .prepare('SELECT i.id, i.file_id, f.path AS file_path, i.module, i.imported_name FROM imports i JOIN files f ON f.id = i.file_id')
      .all() as Array<{ id: number; file_id: number; file_path: string; module: string; imported_name: string }>;
  }
```
Then add a new method immediately after `setImportResolution` (after line 159):
```ts
  /** Clone an import row to attribute it to an additional resolved file (package-level imports). */
  insertResolvedImport(fileId: number, module: string, importedName: string, resolvedFileId: number): void {
    this.raw
      .prepare('INSERT INTO imports (file_id, module, imported_name, resolved_file_id) VALUES (?, ?, ?, ?)')
      .run(fileId, module, importedName, resolvedFileId);
  }
```

- [ ] **Step 7: Refactor `index-repo.ts` to use `resolveImports` + multi-target resolution**

In `src/indexer/index-repo.ts`:

Replace the import block at the top (lines 1-6) with:
```ts
import fs from 'node:fs';
import path from 'node:path';
import { IndexDb } from './db.js';
import { resolveImports } from './resolve.js';
import { extractFromSource } from '../ast/extract.js';
import type { ScannedFile } from '../types.js';
import { noopProgress, type ProgressFn } from '../core/progress.js';
```

Delete the local `EXTS` constant and the `resolveModule` function (lines 15-29).

Replace the resolution loop (lines 70-78) with:
```ts
    // Resolve the import graph (multi-target: package imports fan out to files)
    const idByPath = db.fileIdByPath();
    const known = new Set(idByPath.keys());
    for (const imp of db.allImports()) {
      const targets = resolveImports(imp.file_path, imp.module, known);
      if (targets.length === 0) {
        db.setImportResolution(imp.id, null);
        continue;
      }
      const ids = targets.map((t) => idByPath.get(t)).filter((x): x is number => x != null);
      if (ids.length === 0) {
        db.setImportResolution(imp.id, null);
        continue;
      }
      db.setImportResolution(imp.id, ids[0]);
      for (let i = 1; i < ids.length; i++) {
        db.insertResolvedImport(imp.file_id, imp.module, imp.imported_name, ids[i]);
      }
    }
    onProgress({ phase: 'resolve', done: 0, total: 0 });
    db.recomputeImporterCounts();
```

- [ ] **Step 8: Wire `extractTreeSitter` to call the registry**

In `src/ast/treesitter/extract.ts`, add the import and replace the return. Change the import block (lines 1-4) to:
```ts
import { Query } from 'web-tree-sitter';
import type { FileExtraction, ExtractedSymbol, Lang } from '../../types.js';
import { getParser, getLanguage } from './runtime.js';
import { registry } from './registry.js';
import { importExtractors } from './imports/index.js';
```
Replace the final return of `extractTreeSitter` (line 38) with:
```ts
  const imports = importExtractors[lang]?.extractImports(tree.rootNode, source) ?? [];
  return { symbols, imports };
```

- [ ] **Step 9: Run tests to verify pass + no regressions**

Run: `npx vitest run test/indexer-resolve.test.ts test/ast.test.ts test/ast-dispatch.test.ts test/index-repo.test.ts`
Expected: PASS — new resolve test green; existing tests unchanged (tree-sitter langs still return `imports: []` because the registry is empty).

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/ast/treesitter/imports/spec.ts src/ast/treesitter/imports/index.ts src/indexer/resolve.ts src/indexer/db.ts src/indexer/index-repo.ts src/ast/treesitter/extract.ts test/indexer-resolve.test.ts
git commit -m "refactor(indexer): per-language import resolver dispatch + multi-target resolution"
```

---

## Task 2: Python import extractor + resolver

**Files:**
- Create: `src/ast/treesitter/imports/python.ts`
- Modify: `src/ast/treesitter/imports/index.ts`
- Test: `test/treesitter-imports-python.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/treesitter-imports-python.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
import os
import a.b.c
from .util import format_currency
from ..foo import bar, baz
from .pkg import *
`;

describe('python import extractor', () => {
  beforeAll(async () => { await warmup(['py']); });

  it('extracts plain and dotted imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    expect(imports.find((i) => i.module === 'os' && i.importedName === '*')).toBeTruthy();
    expect(imports.find((i) => i.module === 'a.b.c' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts relative from-imports with named imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    const util = imports.filter((i) => i.module === '.util');
    expect(util.map((i) => i.importedName)).toContain('format_currency');
  });

  it('extracts parent-relative from-imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    const foo = imports.filter((i) => i.module === '..foo');
    expect(foo.map((i) => i.importedName)).toEqual(expect.arrayContaining(['bar', 'baz']));
  });

  it('extracts wildcard from-imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    expect(imports.find((i) => i.module === '.pkg' && i.importedName === '*')).toBeTruthy();
  });

  it('resolves a relative from-import to a sibling .py file', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['pkg/util.py', 'pkg/mod.py', 'pkg/util/__init__.py']);
    expect(resolve('pkg/mod.py', '.util', known)).toEqual(['pkg/util.py']);
  });

  it('resolves a parent-relative from-import', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['pkg/foo.py', 'pkg/sub/mod.py']);
    expect(resolve('pkg/sub/mod.py', '..foo', known)).toEqual(['pkg/foo.py']);
  });

  it('resolves a dotted absolute import to a module file or __init__', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['a/b/c/__init__.py']);
    expect(resolve('pkg/mod.py', 'a.b.c', known)).toEqual(['a/b/c/__init__.py']);
  });

  it('returns [] for an external (non-relative, non-repo) module', () => {
    const resolve = importExtractors['py']!.resolveImport;
    expect(resolve('pkg/mod.py', 'os', new Set(['pkg/mod.py']))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/treesitter-imports-python.test.ts`
Expected: FAIL — `importExtractors['py']` is undefined; extraction returns `imports: []`.

- [ ] **Step 3: Implement the Python `ImportExtractor`**

Create `src/ast/treesitter/imports/python.ts`:
```ts
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
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
    const names = m[2].trim();
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

/** Count leading dots in a relative module spec; return { up, rest }. up=0 → current dir. */
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
```

- [ ] **Step 4: Register Python**

In `src/ast/treesitter/imports/index.ts`:
```ts
import type { Lang } from '../../../types.js';
import type { ImportExtractor } from './spec.js';
import { pythonImports } from './python.js';

export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {
  py: pythonImports,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/treesitter-imports-python.test.ts`
Expected: PASS. If `descendantsOfType('import_from_statement')` returns nothing, the node type name differs in the installed grammar — print `tree.rootNode.toString()` for `SRC` and use the actual type name. The `.util`/`..foo` text-parsing logic is grammar-agnostic once the statement nodes are found.

- [ ] **Step 6: Run regression suite**

Run: `npx vitest run test/treesitter-python.test.ts test/treesitter-e2e.test.ts test/indexer-resolve.test.ts`
Expected: PASS — symbol extraction unchanged; existing e2e still green; Python now contributes imports (e2e fixture has no imports, so no count change).

- [ ] **Step 7: Commit**

```bash
git add src/ast/treesitter/imports/python.ts src/ast/treesitter/imports/index.ts test/treesitter-imports-python.test.ts
git commit -m "feat(imports): Python import extractor + resolver"
```

---

## Task 3: Go import extractor + resolver (package-level, multi-target)

Go imports are always package paths (directories). One import resolves to **every `.go` file** in the matching directory, so the whole package is flagged load-bearing.

**Files:**
- Create: `src/ast/treesitter/imports/go.ts`
- Modify: `src/ast/treesitter/imports/index.ts`
- Test: `test/treesitter-imports-go.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/treesitter-imports-go.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
package main

import "fmt"
import "github.com/foo/bar/internal/auth"

import (
  "errors"
  "github.com/foo/bar/internal/util"
)
`;

describe('go import extractor', () => {
  beforeAll(async () => { await warmup(['go']); });

  it('extracts single and grouped imports', () => {
    const { imports } = extractTreeSitter('go', SRC);
    const mods = imports.map((i) => i.module).sort();
    expect(mods).toEqual(['errors', 'fmt', 'github.com/foo/bar/internal/auth', 'github.com/foo/bar/internal/util']);
    expect(imports.every((i) => i.importedName === '*')).toBe(true);
  });

  it('resolves an internal package import to every .go file in the matching dir (longest path suffix)', () => {
    const resolve = importExtractors['go']!.resolveImport;
    const known = new Set([
      'internal/auth/auth.go', 'internal/auth/token.go', 'internal/util.go',
      'main.go',
    ]);
    expect(resolve('main.go', 'github.com/foo/bar/internal/auth', known).sort())
      .toEqual(['internal/auth/auth.go', 'internal/auth/token.go']);
  });

  it('resolves a stdlib-looking path that happens to match a dir', () => {
    const resolve = importExtractors['go']!.resolveImport;
    const known = new Set(['errors.go']);
    expect(resolve('main.go', 'errors', known)).toEqual(['errors.go']);
  });

  it('returns [] when no dir path is a suffix of the import path', () => {
    const resolve = importExtractors['go']!.resolveImport;
    expect(resolve('main.go', 'github.com/foo/bar/missing', new Set(['main.go']))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/treesitter-imports-go.test.ts`
Expected: FAIL — `importExtractors['go']` undefined.

- [ ] **Step 3: Implement the Go `ImportExtractor`**

Create `src/ast/treesitter/imports/go.ts`:
```ts
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['import_declaration'])) {
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
```

- [ ] **Step 4: Register Go**

In `src/ast/treesitter/imports/index.ts`, add the import and entry:
```ts
import { goImports } from './go.js';
```
```ts
export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {
  py: pythonImports,
  go: goImports,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/treesitter-imports-go.test.ts`
Expected: PASS. If `import_declaration` is not the node type, inspect with `tree.rootNode.toString()` and adjust `descendantsOfType`.

- [ ] **Step 6: Run regression suite**

Run: `npx vitest run test/treesitter-go.test.ts test/treesitter-imports-python.test.ts test/indexer-resolve.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ast/treesitter/imports/go.ts src/ast/treesitter/imports/index.ts test/treesitter-imports-go.test.ts
git commit -m "feat(imports): Go package-level import extractor + resolver"
```

---

## Task 4: Rust import extractor + resolver (`use` + `mod`)

Rust edges come from `use` declarations (dependencies on other modules) and `mod foo;` declarations (file-creating submodules).

**Files:**
- Create: `src/ast/treesitter/imports/rust.ts`
- Modify: `src/ast/treesitter/imports/index.ts`
- Test: `test/treesitter-imports-rust.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/treesitter-imports-rust.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
use std::collections::HashMap;
use crate::auth::token::Token;
use crate::auth::token::*;
use super::logger;
mod config;
`;

describe('rust import extractor', () => {
  beforeAll(async () => { await warmup(['rust']); });

  it('extracts use declarations', () => {
    const { imports } = extractTreeSitter('rust', SRC);
    expect(imports.find((i) => i.module === 'std::collections::HashMap' && i.importedName === '*')).toBeTruthy();
    expect(imports.find((i) => i.module === 'crate::auth::token::Token' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts wildcard use as module without the trailing ::*', () => {
    const { imports } = extractTreeSitter('rust', SRC);
    expect(imports.find((i) => i.module === 'crate::auth::token' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts super-relative use and mod declarations', () => {
    const { imports } = extractTreeSitter('rust', SRC);
    expect(imports.find((i) => i.module === 'super::logger')).toBeTruthy();
    expect(imports.find((i) => i.module === 'mod:config')).toBeTruthy();
  });

  it('resolves crate:: absolute use to a file or mod.rs', () => {
    const resolve = importExtractors['rust']!.resolveImport;
    const known = new Set(['src/auth/token.rs', 'src/auth/mod.rs']);
    expect(resolve('src/main.rs', 'crate::auth::token::Token', known)).toEqual(['src/auth/token.rs']);
  });

  it('resolves super:: relative use against the importer parent', () => {
    const resolve = importExtractors['rust']!.resolveImport;
    const known = new Set(['src/logger.rs', 'src/auth/mod.rs']);
    expect(resolve('src/auth/mod.rs', 'super::logger', known)).toEqual(['src/logger.rs']);
  });

  it('resolves a mod declaration to a sibling file or mod.rs', () => {
    const resolve = importExtractors['rust']!.resolveImport;
    const known = new Set(['src/config.rs', 'src/main.rs']);
    expect(resolve('src/main.rs', 'mod:config', known)).toEqual(['src/config.rs']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/treesitter-imports-rust.test.ts`
Expected: FAIL — `importExtractors['rust']` undefined.

- [ ] **Step 3: Implement the Rust `ImportExtractor`**

Create `src/ast/treesitter/imports/rust.ts`:
```ts
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['use_declaration'])) {
    const text = node.text.replace(/\s+/g, ' ').trim();
    const m = text.match(/^use\s+(.+?);$/);
    if (!m) continue;
    let spec = m[1].trim();
    let importedName = '*';
    if (spec.endsWith('::*')) {
      spec = spec.slice(0, -3); // `crate::auth::token::*` → `crate::auth::token`
    }
    out.push({ module: spec, importedName });
  }
  // `mod foo;` declares a file dependency on `foo.rs` / `foo/mod.rs`.
  // Encode as a synthetic module prefix so the resolver knows it's a mod decl.
  for (const node of root.descendantsOfType(['mod_declaration'])) {
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
  let segs = moduleSpec.split('::');
  let baseDir = dir;
  if (segs[0] === 'crate') {
    baseDir = 'src'; // crate root maps to src/ (documented assumption)
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
```

- [ ] **Step 4: Register Rust**

In `src/ast/treesitter/imports/index.ts`:
```ts
import { rustImports } from './rust.js';
```
```ts
export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {
  py: pythonImports,
  go: goImports,
  rust: rustImports,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/treesitter-imports-rust.test.ts`
Expected: PASS. If `use_declaration` / `mod_declaration` node types differ, inspect with `tree.rootNode.toString()` and adjust.

- [ ] **Step 6: Run regression suite**

Run: `npx vitest run test/treesitter-rust.test.ts test/indexer-resolve.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ast/treesitter/imports/rust.ts src/ast/treesitter/imports/index.ts test/treesitter-imports-rust.test.ts
git commit -m "feat(imports): Rust use/mod import extractor + resolver"
```

---

## Task 5: Java import extractor + resolver (class → file, `*` → package dir)

**Files:**
- Create: `src/ast/treesitter/imports/java.ts`
- Modify: `src/ast/treesitter/imports/index.ts`
- Test: `test/treesitter-imports-java.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/treesitter-imports-java.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
package com.example.app;

import com.example.auth.Token;
import com.example.auth.*;
import java.util.List;
`;

describe('java import extractor', () => {
  beforeAll(async () => { await warmup(['java']); });

  it('extracts single-class imports', () => {
    const { imports } = extractTreeSitter('java', SRC);
    expect(imports.find((i) => i.module === 'com.example.auth.Token' && i.importedName === 'Token')).toBeTruthy();
  });

  it('extracts wildcard imports with the package as module', () => {
    const { imports } = extractTreeSitter('java', SRC);
    expect(imports.find((i) => i.module === 'com.example.auth' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts stdlib imports (kept as edges; resolver drops them)', () => {
    const { imports } = extractTreeSitter('java', SRC);
    expect(imports.find((i) => i.module === 'java.util.List')).toBeTruthy();
  });

  it('resolves a class import to its .java file', () => {
    const resolve = importExtractors['java']!.resolveImport;
    const known = new Set(['com/example/auth/Token.java', 'com/example/app/Main.java']);
    expect(resolve('com/example/app/Main.java', 'com.example.auth.Token', known))
      .toEqual(['com/example/auth/Token.java']);
  });

  it('resolves a wildcard import to every .java file in the package dir', () => {
    const resolve = importExtractors['java']!.resolveImport;
    const known = new Set([
      'com/example/auth/Token.java', 'com/example/auth/Session.java', 'com/example/app/Main.java',
    ]);
    expect(resolve('com/example/app/Main.java', 'com.example.auth', known).sort())
      .toEqual(['com/example/auth/Session.java', 'com/example/auth/Token.java']);
  });

  it('returns [] for an external (java.*) package', () => {
    const resolve = importExtractors['java']!.resolveImport;
    expect(resolve('com/example/app/Main.java', 'java.util.List', new Set(['com/example/app/Main.java'])))
      .toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/treesitter-imports-java.test.ts`
Expected: FAIL — `importExtractors['java']` undefined.

- [ ] **Step 3: Implement the Java `ImportExtractor`**

Create `src/ast/treesitter/imports/java.ts`:
```ts
import type { Node } from 'web-tree-sitter';
import type { ExtractedImport } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

function extractImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const node of root.descendantsOfType(['import_declaration'])) {
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
  // Wildcard / package import → every .java file in the package dir.
  const dirPrefix = `${dotted}/`;
  const hits = [...known].filter((p) => p.startsWith(dirPrefix) && p.endsWith('.java')).sort();
  if (hits.length) return hits;
  return [];
}

export const javaImports: ImportExtractor = { lang: 'java', extractImports, resolveImport };
```

- [ ] **Step 4: Register Java**

In `src/ast/treesitter/imports/index.ts`:
```ts
import { javaImports } from './java.js';
```
```ts
export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {
  py: pythonImports,
  go: goImports,
  rust: rustImports,
  java: javaImports,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/treesitter-imports-java.test.ts`
Expected: PASS.

- [ ] **Step 6: Run regression suite**

Run: `npx vitest run test/treesitter-java.test.ts test/indexer-resolve.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ast/treesitter/imports/java.ts src/ast/treesitter/imports/index.ts test/treesitter-imports-java.test.ts
git commit -m "feat(imports): Java class/package import extractor + resolver"
```

---

## Task 6: Cross-language fan-in e2e

End-to-end proof that a high-fan-in Tree-sitter file is flagged by `context` (dangerous file) and `validate-diff` (dangerous-edit).

**Files:**
- Create: `test/fixtures/fanin-repo/` (fixture files below)
- Test: `test/fanin-e2e.test.ts`

- [ ] **Step 1: Create the fixture repo**

`test/fixtures/fanin-repo/.gitignore`:
```
node_modules/
```

`test/fixtures/fanin-repo/util.py`:
```python
def format_currency(amount, currency):
    """Format a money amount."""
    return f"{currency} {amount:.2f}"
```

`test/fixtures/fanin-repo/a.py`:
```python
from .util import format_currency

def use_a():
    return format_currency(1, "USD")
```

`test/fixtures/fanin-repo/b.py`:
```python
from .util import format_currency

def use_b():
    return format_currency(2, "EUR")
```

> Note: relative `from .util` requires the repo to be importable as a package. For Sensei's resolver this doesn't matter — it resolves `.util` from `b.py` to `util.py` purely by path. No `__init__.py` needed for indexing.

`test/fixtures/fanin-repo/main.go`:
```go
package main

import "github.com/foo/bar/internal/auth"

func main() {}
```

`test/fixtures/fanin-repo/internal/auth/auth.go`:
```go
package auth

func Authenticate(user string) bool { return true }
```

`test/fixtures/fanin-repo/internal/auth/token.go`:
```go
package auth

func IssueToken() string { return "tok" }
```

- [ ] **Step 2: Write the failing e2e test**

Create `test/fanin-e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';
import { runValidateDiff } from '../src/core/run-validate-diff.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fanin-repo');
const FIXED = new Date('2026-06-26T00:00:00Z');
let work: string;

async function commitAll(dir: string, message: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.add('.');
  await git.commit(message);
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-fanin-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('cross-language fan-in (e2e)', () => {
  it('flags util.py as dangerous (2 importers) in context', async () => {
    const report = await runContext(work, 'format some money', { write: false });
    const util = report.dangerousFiles.find((d) => d.path === 'util.py');
    expect(util).toBeTruthy();
    expect(util!.importerCount).toBeGreaterThanOrEqual(2);
  });

  it('flags a dangerous edit to util.py via validate-diff', async () => {
    fs.writeFileSync(path.join(work, 'util.py'), 'def format_currency(a, c):\n    return ""\n');
    await simpleGit(work).add('.');
    const report = await runValidateDiff(work, { mode: 'staged' }, {}, FIXED);
    const danger = report.findings.find((f) => f.kind === 'dangerous-edit' && f.file === 'util.py');
    expect(danger).toBeTruthy();
  });

  it('flags the Go auth package files as dangerous (1 package importer)', async () => {
    const report = await runContext(work, 'authenticate a user', { write: false });
    const auth = report.dangerousFiles.find((d) => d.path === 'internal/auth/auth.go');
    expect(auth).toBeTruthy();
    expect(auth!.importerCount).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/fanin-e2e.test.ts`
Expected: FAIL if any extractor/resolver is mis-wired — e.g. `util.py` not flagged (no importers counted) or `internal/auth/auth.go` missing.

- [ ] **Step 4: If failing, inspect the index**

If a fan-in count is wrong, add a temporary debug to confirm what `imports` rows exist after scan:
```ts
import { IndexDb } from '../src/indexer/db.js';
import { dbPath } from '../src/paths.js';
const db = new IndexDb(dbPath(work));
console.log(db.allImports());
console.log(db.allFiles().map((f) => ({ path: f.path, ic: f.importer_count })));
db.close();
```
Fix the relevant extractor/resolver, then re-run. Common causes: a node-type name mismatch (re-run with `tree.rootNode.toString()`), or a resolver candidate-path off-by-one for relative specs.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/fanin-e2e.test.ts`
Expected: PASS — `util.py` flagged with importer_count ≥ 2; dangerous edit caught; Go auth package files flagged.

- [ ] **Step 6: Run the FULL suite (regression gate)**

Run: `npm test`
Expected: all tests pass — original suite plus all new import/fan-in tests. If `test/treesitter-e2e.test.ts` now asserts `result.warnings` is `[]` and fails because of a Python extractor warning, inspect and fix the extractor (it should not warn on the fixture).

- [ ] **Step 7: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: no errors; `dist/` emitted.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/fanin-repo test/fanin-e2e.test.ts
git commit -m "test(fanin): cross-language high-fan-in e2e (python, go)"
```

---

## Task 7: Documentation + release

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json:3`
- Modify: `docs/superpowers/specs/2026-06-20-sensei-roadmap.md`

- [ ] **Step 1: Flip the README Languages table**

In `README.md`, find the Languages table (around line 165-168) and change the Tree-sitter row's Dangerous-by-fan-in cell from `❌ (use \`dangerous.paths\`)` to `✅`. Replace the table:
```markdown
| Language | Parser | Reuse detection | Dangerous-by-fan-in |
|----------|--------|-----------------|---------------------|
| TypeScript / JavaScript | `typescript` compiler | ✅ | ✅ |
| Python, Go, Rust, Java | Tree-sitter | ✅ | ✅ |
```
Replace the paragraph immediately after the table (around line 170) with:
```markdown
For the Tree-sitter languages, `validate-diff`/`validate-plan` detect duplicate symbols and flag high-fan-in files from the import graph, just like TS/JS. Go and Java package-level imports attribute fan-in to every file in the imported package. `dangerous.paths` globs remain available as an additional, language-independent signal.
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new section at the top (above `## [0.10.0]`):
```markdown
## [0.11.0] - 2026-06-26

### Added

- **Tree-sitter fan-in danger detection** — high-fan-in "do not touch" detection now works for Python, Go, Rust, and Java, not just TS/JS. Each Tree-sitter language has a dedicated import extractor that walks the parsed tree and normalizes imports into Sensei's shared edge format; the existing fan-in analyzer is unchanged. `context`, `validate-diff`, and `validate-plan` now flag load-bearing files in every supported language. Go and Java package-level imports attribute fan-in to every file in the imported package.

### Notes

- Import resolution is static and best-effort at the same depth as TS/JS: direct imports only, no transitive edges, no type-level resolution. Python resolves relative (`from .`) and absolute dotted imports; Rust resolves `crate::`, `super::`, `self::`, and `mod foo;` declarations; Go matches import paths by longest directory-path suffix (no `go.mod` read); Java maps `com.example.auth.Token` to `com/example/auth/Token.java` and `.*` to all files in the package directory.
- `dangerous.paths` globs remain available and unchanged.
```
Append the link entry at the bottom of the link reference list (after the `[0.10.0]` line):
```markdown
[0.11.0]: https://github.com/deneuv34/sensei/releases/tag/v0.11.0
```

- [ ] **Step 3: Bump the version**

In `package.json` line 3, change `"version": "0.10.0"` to `"version": "0.11.0"`.

- [ ] **Step 4: Update the roadmap spec — move 0.11.0 to shipped, close gap #1**

In `docs/superpowers/specs/2026-06-20-sensei-roadmap.md`:

In §1, add a row to the shipped table after the `0.10.0` row:
```markdown
| `0.11.0` | Tree-sitter fan-in danger detection (Python, Go, Rust, Java) |
```

In §2, change gap #1 to strikethrough and mark it closed:
```markdown
1. ~~**High-fan-in "dangerous" detection is TS/JS-only.**~~ **Closed by `0.11.0`.**
```

In §3, mark the `0.11.0` milestone as shipped (add a note under its heading):
```markdown
### `0.11.0` — Tree-sitter fan-in danger detection *(shipped 2026-06-26)*
```
Update the `1.0.0` subsection's first line to:
```markdown
Tagged **after `0.11.0` shipped and verified** …
```
(Leave the rest of the `1.0.0` subsection as-is.)

Update the "Current version" line at the top from `0.10.0` to `0.11.0`.

- [ ] **Step 5: Run the full suite + build once more**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md package.json docs/superpowers/specs/2026-06-20-sensei-roadmap.md
git commit -m "docs: 0.11.0 — Tree-sitter fan-in danger detection shipped"
```

---

## Done criteria

- `npm test` green (original suite + 5 new import-extractor test files + resolve dispatch test + fan-in e2e).
- `npm run typecheck && npm run build` clean.
- A Python/Go/Rust/Java file imported by ≥ `dangerous.importerThreshold` files appears in `context`'s `dangerousFiles`.
- `validate-diff` flags a `dangerous-edit` when such a file is edited.
- `validate-plan` flags a `dangerous-target` when such a file is proposed.
- TS/JS behavior unchanged (existing TS tests green; `resolveImports` returns the same single path for TS relative imports).
- README Languages table shows ✅ across the board; CHANGELOG has `0.11.0`; roadmap spec reflects it as shipped; `package.json` at `0.11.0`.
