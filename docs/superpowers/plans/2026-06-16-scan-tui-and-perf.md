# Scan TUI + Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sensei scan` fast on large repos and give it a live, phased terminal UI so it never looks frozen.

**Architecture:** Collapse N per-file `git log` spawns into one batched pass; swap the heavy ts-morph parser for raw `typescript`. Core stays headless and emits progress through an injected callback; the `scan` command owns a `listr2` task list that translates those events into a four-phase UI.

**Tech Stack:** TypeScript (ESM, NodeNext), oclif, better-sqlite3, fast-glob, simple-git, `typescript` compiler API, `listr2`, vitest.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/progress.ts` | NEW. Progress event types (`ScanPhase`, `ScanProgress`, `ProgressFn`, `noopProgress`). |
| `src/scanner/git-meta.ts` | NEW. Run one `git log` and parse stdout into a `path → {lastModified, commitCount}` map. |
| `src/scanner/scan.ts` | MODIFY. Reorder to read+hash first, then one git-meta pass; emit `discover`/`gitmeta` progress. |
| `src/ast/extract.ts` | REWRITE. Use `ts.createSourceFile` instead of ts-morph. |
| `src/indexer/index-repo.ts` | MODIFY. Emit `parse`/`resolve` progress. |
| `src/core/run-scan.ts` | MODIFY. Thread optional `onProgress` to scanner + indexer. |
| `src/commands/scan.ts` | MODIFY. listr2 four-phase UI, `--verbose` flag, footer. |
| `package.json` | MODIFY. `+ listr2`, `+ typescript`, `− ts-morph`. |
| `test/git-meta.test.ts` | NEW. Parse fixtures → map. |
| `test/progress.test.ts` | NEW. Phase order + monotonic `done`. |
| `test/ast.test.ts` | MODIFY. Add cases for arrow-fn const, default export, side-effect import. |

---

## Task 1: Swap dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new deps, remove ts-morph**

```bash
npm install listr2 typescript
npm uninstall ts-morph
```

- [ ] **Step 2: Verify package.json**

Run: `node -e "const p=require('./package.json'); console.log('listr2',!!p.dependencies.listr2,'typescript',!!p.dependencies.typescript,'ts-morph',!!p.dependencies['ts-morph'])"`
Expected: `listr2 true typescript true ts-morph false`

- [ ] **Step 3: Confirm build still resolves (extract.ts not yet migrated — expect it to fail on ts-morph import)**

Run: `npm run typecheck`
Expected: FAIL — `Cannot find module 'ts-morph'` in `src/ast/extract.ts`. This is expected; Task 5 fixes it. Do not commit yet.

- [ ] **Step 4: Temporarily keep build green by deferring commit**

Do NOT commit Task 1 alone. Commit it together with Task 5 (the extract rewrite that removes the ts-morph import). Proceed to Task 2.

---

## Task 2: Progress event module

**Files:**
- Create: `src/core/progress.ts`

- [ ] **Step 1: Create the module**

```ts
// src/core/progress.ts

/** Pipeline phase a progress event belongs to. */
export type ScanPhase = 'discover' | 'gitmeta' | 'parse' | 'resolve';

export interface ScanProgress {
  phase: ScanPhase;
  /** items processed so far within the phase */
  done: number;
  /** total items in the phase; 0 means indeterminate */
  total: number;
  /** current item, e.g. a file path */
  detail?: string;
}

export type ProgressFn = (progress: ScanProgress) => void;

/** Default reporter: discards events, keeping core headless. */
export const noopProgress: ProgressFn = () => {};
```

- [ ] **Step 2: Typecheck the new file compiles in isolation**

Run: `npx tsc --noEmit src/core/progress.ts --module nodenext --moduleResolution nodenext --target es2022`
Expected: no output (success). (Project-wide typecheck still fails until Task 5; that is fine.)

- [ ] **Step 3: Commit**

```bash
git add src/core/progress.ts
git commit -m "feat(scan): add progress event types"
```

---

## Task 3: Batched git metadata

**Files:**
- Create: `src/scanner/git-meta.ts`
- Test: `test/git-meta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/git-meta.test.ts
import { describe, it, expect } from 'vitest';
import { parseGitLog } from '../src/scanner/git-meta.js';

// Format produced by: git log --name-only --format=__C__%ct
// Newest commit first. Header line marks a commit + its committer timestamp.
const STDOUT = [
  '__C__1700000300',
  'src/auth/login.ts',
  'src/user/profile.ts',
  '',
  '__C__1700000200',
  'src/auth/login.ts',
  '',
  '__C__1700000100',
  'src/user/profile.ts',
  '',
].join('\n');

describe('parseGitLog', () => {
  it('maps each path to its newest commit time and total commit count', () => {
    const map = parseGitLog(STDOUT);
    expect(map.get('src/auth/login.ts')).toEqual({ lastModified: 1700000300, commitCount: 2 });
    expect(map.get('src/user/profile.ts')).toEqual({ lastModified: 1700000300, commitCount: 2 });
  });

  it('returns an empty map for empty stdout', () => {
    expect(parseGitLog('').size).toBe(0);
    expect(parseGitLog('\n\n').size).toBe(0);
  });

  it('ignores file lines with no preceding commit header', () => {
    const map = parseGitLog('orphan.ts\n__C__1700000100\nreal.ts\n');
    expect(map.has('orphan.ts')).toBe(false);
    expect(map.get('real.ts')).toEqual({ lastModified: 1700000100, commitCount: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/git-meta.test.ts`
Expected: FAIL — `parseGitLog` is not exported / module not found.

- [ ] **Step 3: Implement git-meta**

```ts
// src/scanner/git-meta.ts
import { simpleGit } from 'simple-git';

export interface GitMeta {
  /** unix seconds of the newest commit touching the path */
  lastModified: number;
  /** number of commits touching the path */
  commitCount: number;
}

const COMMIT_MARKER = '__C__';

/** Pure parser over `git log --name-only --format=__C__%ct` stdout. */
export function parseGitLog(stdout: string): Map<string, GitMeta> {
  const map = new Map<string, GitMeta>();
  let currentTime: number | null = null;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith(COMMIT_MARKER)) {
      const ts = Number(line.slice(COMMIT_MARKER.length));
      currentTime = Number.isFinite(ts) ? ts : null;
      continue;
    }

    if (currentTime === null) continue; // file line with no commit header: ignore

    const existing = map.get(line);
    if (existing) {
      existing.commitCount += 1; // log is newest-first, so lastModified already correct
    } else {
      map.set(line, { lastModified: currentTime, commitCount: 1 });
    }
  }

  return map;
}

/**
 * Run a single `git log` over the whole repo and parse it.
 * Returns an empty map when not a git repo or git fails — callers fall back to defaults.
 */
export async function gitMetaMap(cwd: string): Promise<Map<string, GitMeta>> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) return new Map();
  try {
    const stdout = await git.raw(['log', '--name-only', `--format=${COMMIT_MARKER}%ct`]);
    return parseGitLog(stdout);
  } catch {
    return new Map();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/git-meta.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scanner/git-meta.ts test/git-meta.test.ts
git commit -m "feat(scan): batch git metadata into a single log pass"
```

---

## Task 4: Reorder scanRepo to use batched git-meta + emit progress

**Files:**
- Modify: `src/scanner/scan.ts`
- Test: `test/scanner.test.ts` (existing — must stay green)

- [ ] **Step 1: Rewrite scanRepo**

Replace the entire body of `src/scanner/scan.ts` from the `export async function scanRepo` declaration down with this. Keep the imports above it, but **remove** the `simpleGit` import (now unused here) and **add** the new imports.

```ts
// at top of file: remove `import { simpleGit } from 'simple-git';`
// add:
import { gitMetaMap } from './git-meta.js';
import { noopProgress, type ProgressFn } from '../core/progress.js';

export async function scanRepo(
  cwd: string,
  config: SenseiConfig,
  onProgress: ProgressFn = noopProgress,
): Promise<ScannedFile[]> {
  const entries = await fg(config.include, {
    cwd,
    ignore: config.ignore,
    onlyFiles: true,
    dot: false,
  });

  const ig = createIgnore();
  const giPath = path.join(cwd, '.gitignore');
  if (fs.existsSync(giPath)) ig.add(fs.readFileSync(giPath, 'utf8'));
  const kept = entries.filter((p) => !ig.ignores(p)).sort();

  onProgress({ phase: 'discover', done: 0, total: kept.length });

  // Phase 1: read + hash every kept file (fast I/O; no git spawn).
  const files: ScannedFile[] = [];
  for (const rel of kept) {
    const abs = path.join(cwd, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable file: skip
    }
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    const loc = content.length === 0 ? 0 : content.split('\n').length;
    const posix = toPosix(rel);
    files.push({ path: posix, hash, lang: extLang(rel), loc, gitLastModified: null, gitCommitCount: 0 });
    onProgress({ phase: 'discover', done: files.length, total: kept.length, detail: posix });
  }

  // Phase 2: one git-log pass, then attach metadata by lookup.
  const meta = await gitMetaMap(cwd);
  for (const f of files) {
    const m = meta.get(f.path);
    if (m) {
      f.gitLastModified = m.lastModified;
      f.gitCommitCount = m.commitCount;
    }
  }
  onProgress({ phase: 'gitmeta', done: meta.size, total: files.length, detail: `${meta.size} files mapped` });

  return files;
}
```

- [ ] **Step 2: Run the existing scanner test (proves behavior preserved)**

Run: `npx vitest run test/scanner.test.ts`
Expected: PASS — paths, sorting, hash, lang, loc unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/scanner/scan.ts
git commit -m "perf(scan): batch git metadata, emit discover/gitmeta progress"
```

---

## Task 5: Rewrite the AST extractor on raw TypeScript

**Files:**
- Modify: `src/ast/extract.ts` (full rewrite)
- Modify: `package.json` (Task 1 changes get committed here)
- Test: `test/ast.test.ts` (existing — must stay green)

- [ ] **Step 1: Replace extract.ts entirely**

```ts
// src/ast/extract.ts
import ts from 'typescript';
import type { FileExtraction, ExtractedSymbol, ExtractedImport } from '../types.js';

function scriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function jsdocText(node: ts.Node): string {
  const parts: string[] = [];
  for (const item of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(item) && item.comment) {
      parts.push(
        typeof item.comment === 'string'
          ? item.comment
          : item.comment.map((c) => c.text).join(''),
      );
    }
  }
  return parts.join(' ').trim();
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function paramsText(sf: ts.SourceFile, params: ts.NodeArray<ts.ParameterDeclaration>): string {
  return params.map((p) => p.getText(sf)).join(', ');
}

function callSignature(
  sf: ts.SourceFile,
  name: string,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  ret: ts.TypeNode | undefined,
): string {
  const retText = ret?.getText(sf);
  return `${name}(${paramsText(sf, params)})${retText ? ': ' + retText : ''}`;
}

export function extractFromSource(filePath: string, source: string): FileExtraction {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      symbols.push({
        kind: 'function',
        name,
        signature: callSignature(sf, name, stmt.parameters, stmt.type),
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      const exported = hasExportModifier(stmt);
      symbols.push({
        kind: 'class',
        name,
        signature: `class ${name}`,
        exported,
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const mName = member.name.text;
          symbols.push({
            kind: 'method',
            name: `${name}.${mName}`,
            signature: callSignature(sf, mName, member.parameters, member.type),
            exported,
            startLine: lineOf(sf, member),
            jsdoc: jsdocText(member),
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(stmt)) {
      symbols.push({
        kind: 'interface',
        name: stmt.name.text,
        signature: `interface ${stmt.name.text}`,
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      symbols.push({
        kind: 'type',
        name: stmt.name.text,
        signature: `type ${stmt.name.text}`,
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      symbols.push({
        kind: 'enum',
        name: stmt.name.text,
        signature: `enum ${stmt.name.text}`,
        exported: hasExportModifier(stmt),
        startLine: lineOf(sf, stmt),
        jsdoc: jsdocText(stmt),
      });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt);
      const jsdoc = jsdocText(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue; // skip destructuring patterns
        const name = decl.name.text;
        symbols.push({
          kind: 'const',
          name,
          signature: name,
          exported,
          startLine: lineOf(sf, decl),
          jsdoc,
        });
      }
    } else if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const module = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) {
        imports.push({ module, importedName: '' }); // side-effect import
        continue;
      }
      let added = false;
      if (clause.name) {
        imports.push({ module, importedName: 'default' });
        added = true;
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          imports.push({ module, importedName: '*' });
          added = true;
        } else {
          for (const el of clause.namedBindings.elements) {
            imports.push({ module, importedName: el.name.text });
            added = true;
          }
        }
      }
      if (!added) imports.push({ module, importedName: '' });
    }
  }

  return { symbols, imports };
}
```

- [ ] **Step 2: Add regression cases to the existing AST test**

In `test/ast.test.ts`, extend the `SRC` constant and add three assertions. Replace the `SRC` template literal with:

```ts
const SRC = `
import { login } from '../auth/login.js';
import Default from 'pkg';
import './side-effect.js';
import * as ns from 'nspkg';

/** Authenticate. */
export function authenticate(user: string, pass: string): boolean {
  return login(user, pass);
}

export class Session {
  start(): void {}
}

export default function bootstrap(): void {}

export const makeId = (): string => 'x';

const internalHelper = 1;
export const TOKEN_TTL = 3600;
`;
```

Then append these tests inside the `describe` block:

```ts
it('extracts arrow-function consts as const symbols', () => {
  const { symbols } = extractFromSource('src/user/auth.ts', SRC);
  const makeId = symbols.find((s) => s.name === 'makeId')!;
  expect(makeId.kind).toBe('const');
  expect(makeId.exported).toBe(true);
});

it('marks default-exported declarations as exported', () => {
  const { symbols } = extractFromSource('src/user/auth.ts', SRC);
  expect(symbols.find((s) => s.name === 'bootstrap')!.exported).toBe(true);
});

it('captures side-effect and namespace imports', () => {
  const { imports } = extractFromSource('src/user/auth.ts', SRC);
  expect(imports).toContainEqual({ module: './side-effect.js', importedName: '' });
  expect(imports).toContainEqual({ module: 'nspkg', importedName: '*' });
});
```

- [ ] **Step 3: Run the AST tests**

Run: `npx vitest run test/ast.test.ts`
Expected: PASS — original 4 tests + 3 new tests.

- [ ] **Step 4: Project typecheck now clean (ts-morph import gone)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit (includes the Task 1 package.json swap)**

```bash
git add package.json package-lock.json src/ast/extract.ts test/ast.test.ts
git commit -m "perf(scan): replace ts-morph with raw typescript parser"
```

---

## Task 6: Emit parse/resolve progress from the indexer

**Files:**
- Modify: `src/indexer/index-repo.ts`
- Test: `test/index-repo.test.ts` (existing — must stay green)

- [ ] **Step 1: Add the progress import**

At the top of `src/indexer/index-repo.ts`, after the existing imports, add:

```ts
import { noopProgress, type ProgressFn } from '../core/progress.js';
```

- [ ] **Step 2: Add the parameter and emit ticks**

Change the `indexFiles` signature and add emissions. Replace the function header line:

```ts
export function indexFiles(db: IndexDb, cwd: string, files: ScannedFile[]): IndexResult {
```

with:

```ts
export function indexFiles(
  db: IndexDb,
  cwd: string,
  files: ScannedFile[],
  onProgress: ProgressFn = noopProgress,
): IndexResult {
```

Inside the `for (const f of files)` loop, immediately after `changed++;`, add:

```ts
      onProgress({ phase: 'parse', done: changed, total: files.length, detail: f.path });
```

Just before `db.recomputeImporterCounts();`, add:

```ts
    onProgress({ phase: 'resolve', done: 0, total: 0 });
```

(Resolve runs inside the transaction; a single indeterminate tick is enough for the UI.)

- [ ] **Step 3: Run the existing indexer test**

Run: `npx vitest run test/index-repo.test.ts`
Expected: PASS — both tests (symbol indexing + incremental).

- [ ] **Step 4: Commit**

```bash
git add src/indexer/index-repo.ts
git commit -m "feat(scan): emit parse/resolve progress from indexer"
```

---

## Task 7: Thread onProgress through runScan

**Files:**
- Modify: `src/core/run-scan.ts`

- [ ] **Step 1: Update runScan**

Replace the full contents of `src/core/run-scan.ts` with:

```ts
import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { scanRepo } from '../scanner/scan.js';
import { IndexDb } from '../indexer/db.js';
import { indexFiles, type IndexResult } from '../indexer/index-repo.js';
import { dbPath, senseiDir } from '../paths.js';
import { noopProgress, type ProgressFn } from './progress.js';

export async function runScan(cwd: string, onProgress: ProgressFn = noopProgress): Promise<IndexResult> {
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  const config = loadConfig(cwd);
  const files = await scanRepo(cwd, config, onProgress);
  const db = new IndexDb(dbPath(cwd));
  try {
    db.migrate();
    const result = indexFiles(db, cwd, files, onProgress);
    db.setMeta('schema_version', '1');
    db.setMeta('last_scan', new Date().toISOString());
    return result;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/run-scan.ts
git commit -m "feat(scan): thread progress reporter through runScan"
```

---

## Task 8: Progress integration test

**Files:**
- Create: `test/progress.test.ts`

- [ ] **Step 1: Write the test**

```ts
// test/progress.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { runScan } from '../src/core/run-scan.js';
import type { ScanPhase, ScanProgress } from '../src/core/progress.js';

const sampleRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('runScan progress', () => {
  it('reports phases in order with non-decreasing done within a phase', async () => {
    // copy fixture to a temp dir so the .sensei db is not written into the repo
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-progress-'));
    fs.cpSync(sampleRepo, tmp, { recursive: true });

    const events: ScanProgress[] = [];
    await runScan(tmp, (p) => events.push(p));

    expect(events.length).toBeGreaterThan(0);

    // Phase order: each phase's first appearance must follow the canonical order.
    const order: Record<ScanPhase, number> = { discover: 0, gitmeta: 1, parse: 2, resolve: 3 };
    const firstSeen: Partial<Record<ScanPhase, number>> = {};
    events.forEach((e, i) => {
      if (firstSeen[e.phase] === undefined) firstSeen[e.phase] = i;
    });
    const seenPhases = Object.keys(firstSeen) as ScanPhase[];
    const byFirstSeen = [...seenPhases].sort((a, b) => firstSeen[a]! - firstSeen[b]!);
    const byCanonical = [...seenPhases].sort((a, b) => order[a] - order[b]);
    expect(byFirstSeen).toEqual(byCanonical);

    // discover ticks are monotonically non-decreasing in `done`
    const discoverDone = events.filter((e) => e.phase === 'discover').map((e) => e.done);
    for (let i = 1; i < discoverDone.length; i++) {
      expect(discoverDone[i]).toBeGreaterThanOrEqual(discoverDone[i - 1]);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/progress.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/progress.test.ts
git commit -m "test(scan): assert progress phase order and monotonicity"
```

---

## Task 9: listr2 four-phase UI in the scan command

**Files:**
- Modify: `src/commands/scan.ts` (full rewrite)

- [ ] **Step 1: Rewrite the command**

```ts
// src/commands/scan.ts
import { Command, Flags } from '@oclif/core';
import { Listr } from 'listr2';
import { runScan } from '../core/run-scan.js';
import type { IndexResult } from '../indexer/index-repo.js';
import type { ScanPhase, ScanProgress } from '../core/progress.js';

const PHASE_ORDER: Record<ScanPhase, number> = { discover: 0, gitmeta: 1, parse: 2, resolve: 3 };

function renderProgress(p: ScanProgress): string {
  const count = p.total > 0 ? `${p.done}/${p.total}` : `${p.done}`;
  return p.detail ? `${count}  ${p.detail}` : count;
}

/**
 * Bridges the headless progress callback to listr2 tasks. A phase completes when
 * a later-phase event arrives (events are monotonic) or when the scan finishes.
 */
class ScanCoordinator {
  readonly promises = new Map<ScanPhase, Promise<void>>();
  private resolvers = new Map<ScanPhase, () => void>();
  private outputs = new Map<ScanPhase, (s: string) => void>();
  private latest = new Map<ScanPhase, ScanProgress>();

  constructor() {
    for (const phase of Object.keys(PHASE_ORDER) as ScanPhase[]) {
      this.promises.set(phase, new Promise<void>((res) => this.resolvers.set(phase, res)));
    }
  }

  bindOutput(phase: ScanPhase, set: (s: string) => void): void {
    this.outputs.set(phase, set);
    const last = this.latest.get(phase);
    if (last) set(renderProgress(last));
  }

  readonly handle = (p: ScanProgress): void => {
    this.latest.set(p.phase, p);
    this.outputs.get(p.phase)?.(renderProgress(p));
    // Any event completes all strictly-earlier phases.
    for (const [phase, n] of Object.entries(PHASE_ORDER) as [ScanPhase, number][]) {
      if (n < PHASE_ORDER[p.phase]) this.resolvers.get(phase)!();
    }
  };

  finishAll(): void {
    for (const resolve of this.resolvers.values()) resolve();
  }
}

export default class Scan extends Command {
  static description = 'Scan the repo and build the local symbol index.';

  static flags = {
    verbose: Flags.boolean({ description: 'List all warnings instead of a count.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Scan);
    const cwd = process.cwd();
    const coord = new ScanCoordinator();

    const scanPromise: Promise<IndexResult> = runScan(cwd, coord.handle).then((r) => {
      coord.finishAll();
      return r;
    });

    const phaseTask = (phase: ScanPhase) => async (_ctx: unknown, task: { output: string }) => {
      coord.bindOutput(phase, (s) => {
        task.output = s;
      });
      await coord.promises.get(phase);
    };

    const tasks = new Listr(
      [
        { title: 'Discover files', task: phaseTask('discover') },
        { title: 'Git history', task: phaseTask('gitmeta') },
        { title: 'Parse & index', task: phaseTask('parse') },
        { title: 'Resolve imports', task: phaseTask('resolve') },
      ],
      { concurrent: false, exitOnError: true, rendererOptions: { collapseSubtasks: false } },
    );

    await tasks.run();
    const result = await scanPromise;

    this.log('');
    this.log(
      `Scanned ${result.fileCount} files (${result.changed} changed), indexed ${result.symbolCount} symbols.`,
    );
    if (result.warnings.length) {
      if (flags.verbose) {
        this.log(`Warnings (${result.warnings.length}):`);
        for (const w of result.warnings) this.log(`  ! ${w}`);
      } else {
        this.log(`⚠ ${result.warnings.length} warnings (run with --verbose to see).`);
      }
    }
    this.log('Next: run `sensei context "<your task>"`.');
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/scan.ts
git commit -m "feat(scan): live four-phase listr2 progress UI with --verbose"
```

---

## Task 10: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites PASS (including unchanged e2e, guard, validate suites).

- [ ] **Step 2: Manual smoke run on this repo (TTY)**

Run: `node bin/run.js scan`
Expected: four task rows animate (Discover → Git history → Parse & index → Resolve), then the footer:
`Scanned N files (M changed), indexed K symbols.` followed by the `Next:` line.

- [ ] **Step 3: Manual smoke run piped (non-TTY fallback)**

Run: `node bin/run.js scan | cat`
Expected: plain non-animated lines (listr2 simple renderer) + the same footer. No ANSI cursor garbage.

- [ ] **Step 4: Verify the speedup is real (informal)**

Run: `time node bin/run.js scan`
Expected: completes in well under a second on this repo; the previous per-file `git log` path is gone (one `git log` invocation total — confirm with `GIT_TRACE=1 node bin/run.js scan 2>&1 | grep -c "trace: built-in: git log"` → `1`).

- [ ] **Step 5: Final commit if any incidental changes**

```bash
git add -A
git commit -m "chore(scan): verification pass for TUI + perf" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** A1 → Task 3+4; A2 → Task 5; B → Tasks 2,6,7; C → Task 9; D errors → git-meta empty-map fallback (Task 3) + existing warning/skip paths preserved (Tasks 5,6) + `exitOnError` (Task 9); testing → Tasks 3,5,8.
- **Type consistency:** `ScanPhase`/`ScanProgress`/`ProgressFn`/`noopProgress` defined once (Task 2) and imported everywhere. `parseGitLog`/`gitMetaMap`/`GitMeta` names consistent across Tasks 3–4. `phaseTask`/`ScanCoordinator` self-contained in Task 9.
- **Known limitation (documented, accepted):** `commitCount` now counts via a single `git log` and excludes merge commits' file lists (git omits them without `-m`); this is a scoring heuristic, drift is acceptable. `export { foo }` separate-statement exports are not marked `exported` (only inline `export` modifiers) — matches existing test coverage and the prior behavior for the common case.
