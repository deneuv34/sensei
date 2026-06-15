# Sensei `validate-diff` + `guard` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an index-bound `validate-diff` engine that flags duplicated symbols and dangerous-file edits in a git diff, plus a `guard` git-hook installer that runs it.

**Architecture:** New `src/validate/*` (diff resolution, introduced-symbol detection, checks, report) and `src/guard/hook.ts` (managed-block hook writer), orchestrated by `src/core/run-validate-diff.ts` + `src/core/run-guard.ts`, exposed by thin `src/commands/{validate-diff,guard}.ts`. Reuses MVP modules: `ast/extract` (parse changed files), `search/search` (FTS5 recall), `scorer/score#findDangerousFiles` (dangerous set), `indexer/db`, `config`, `text/tokenize`. The only new scoring is a purpose-built name+signature token-Jaccard similarity (the reuse scorer answers a different question — see spec §4.5).

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import suffixes), oclif v4, better-sqlite3 + FTS5, ts-morph, simple-git, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-sensei-validate-diff-design.md`

**Conventions to honor (from CLAUDE.md / clean-code.md):** no `any` / `as unknown as`; no placeholders/TODOs; functions <40 lines, single responsibility; treat params immutable; no magic values (thresholds come from config); Conventional Commits with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Run `npm run typecheck` before each commit.

---

### Task 1: Config — `validate` block

**Files:**
- Modify: `src/config/schema.ts:25-28` (add `validate` object after `dangerous`)
- Test: `test/config.test.ts` (append a case)

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
import { DEFAULT_CONFIG, ConfigSchema } from '../src/config/schema.js';

describe('validate config block', () => {
  it('defaults to warn-only with a 0.7 duplicate threshold and both checks on', () => {
    expect(DEFAULT_CONFIG.validate).toEqual({
      block: false,
      duplicateThreshold: 0.7,
      checkDuplicates: true,
      checkDangerous: true,
    });
  });

  it('accepts overrides', () => {
    const cfg = ConfigSchema.parse({ validate: { block: true, duplicateThreshold: 0.9 } });
    expect(cfg.validate.block).toBe(true);
    expect(cfg.validate.duplicateThreshold).toBe(0.9);
    expect(cfg.validate.checkDuplicates).toBe(true); // unspecified keys keep defaults
  });
});
```

(If `test/config.test.ts` does not already import `describe/it/expect`, add `import { describe, it, expect } from 'vitest';` at the top — check first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `validate` is `undefined`.

- [ ] **Step 3: Implement**

In `src/config/schema.ts`, add this block inside `z.object({ ... })` immediately after the `dangerous` field (before the closing `});`):

```ts
  validate: z
    .object({
      block: z.boolean().default(false),
      duplicateThreshold: z.number().min(0).max(1).default(0.7),
      checkDuplicates: z.boolean().default(true),
      checkDangerous: z.boolean().default(true),
    })
    .default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/config/schema.ts test/config.test.ts
git commit -m "feat: add validate config block (warn-only, 0.7 dup threshold)"
```

---

### Task 2: `IndexDb.symbolsForFile(path)`

**Files:**
- Modify: `src/indexer/db.ts` (add method after `searchSymbols`, ~line 183)
- Test: `test/indexer-db.test.ts` (append a case)

- [ ] **Step 1: Write the failing test**

Append to `test/indexer-db.test.ts` (inside the existing top-level `describe`, or add a new one — match the file's structure):

```ts
import { IndexDb } from '../src/indexer/db.js';

describe('symbolsForFile', () => {
  it('returns name/kind/signature for a file path, empty for unknown', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const fileId = db.upsertFile({
      path: 'src/a.ts', hash: 'h', lang: 'ts', loc: 3, gitLastModified: null, gitCommitCount: 0,
    });
    db.insertSymbol(fileId, {
      kind: 'function', name: 'foo', signature: 'foo(x: number): void',
      exported: true, startLine: 1, jsdoc: '',
    }, 'src/a.ts');

    expect(db.symbolsForFile('src/a.ts')).toEqual([
      { name: 'foo', kind: 'function', signature: 'foo(x: number): void' },
    ]);
    expect(db.symbolsForFile('src/missing.ts')).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/indexer-db.test.ts`
Expected: FAIL — `db.symbolsForFile is not a function`.

- [ ] **Step 3: Implement**

In `src/indexer/db.ts`, add this method to the `IndexDb` class, immediately after the `searchSymbols(...)` method:

```ts
  symbolsForFile(path: string): Array<{ name: string; kind: string; signature: string }> {
    return this.raw
      .prepare(
        `SELECT s.name, s.kind, s.signature
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ?
         ORDER BY s.start_line`,
      )
      .all(path) as Array<{ name: string; kind: string; signature: string }>;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/indexer-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/indexer/db.ts test/indexer-db.test.ts
git commit -m "feat: add IndexDb.symbolsForFile accessor"
```

---

### Task 3: `validate/diff.ts` — resolve changed files

**Files:**
- Create: `src/validate/diff.ts`
- Test: `test/validate-diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/validate-diff.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { changedFiles } from '../src/validate/diff.js';

let work: string;

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-diff-'));
  const git = simpleGit(work);
  await git.init();
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# readme\n');
  await git.add('.');
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('changedFiles', () => {
  it('returns only supported, sorted, posix paths from the staged set', async () => {
    const files = await changedFiles(work, { mode: 'staged' });
    expect(files).toEqual(['src/a.ts']); // README.md filtered out
  });

  it('throws outside a git repository', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-norepo-'));
    await expect(changedFiles(nonRepo, { mode: 'staged' })).rejects.toThrow(/Not a git repository/);
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-diff.test.ts`
Expected: FAIL — cannot find module `../src/validate/diff.js`.

- [ ] **Step 3: Implement**

Create `src/validate/diff.ts`:

```ts
import { simpleGit } from 'simple-git';

export type DiffSource =
  | { mode: 'staged' }
  | { mode: 'all' }
  | { mode: 'against'; ref: string };

const SUPPORTED = /\.(ts|tsx|js|jsx)$/;
const NAME_ONLY = ['--name-only', '--diff-filter=ACMR'];

export async function changedFiles(cwd: string, source: DiffSource): Promise<string[]> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) throw new Error('Not a git repository.');

  let out: string;
  if (source.mode === 'staged') out = await git.diff(['--cached', ...NAME_ONLY]);
  else if (source.mode === 'all') out = await git.diff([...NAME_ONLY, 'HEAD']);
  else out = await git.diff([...NAME_ONLY, `${source.ref}...HEAD`]);

  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && SUPPORTED.test(l))
    .sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/validate/diff.ts test/validate-diff.test.ts
git commit -m "feat: resolve changed files from git diff (staged/all/against)"
```

---

### Task 4: `validate/report.ts` — schema, types, render, write (+ paths)

**Files:**
- Modify: `src/paths.ts` (add `lastValidationJsonPath`)
- Create: `src/validate/report.ts`
- Test: `test/validate-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/validate-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ValidationReportSchema,
  renderValidation,
  writeValidation,
  type ValidationReport,
} from '../src/validate/report.js';
import { lastValidationJsonPath } from '../src/paths.js';

const report: ValidationReport = {
  source: 'staged',
  generatedAt: '2026-06-16T00:00:00.000Z',
  findings: [
    {
      kind: 'duplicate-candidate', severity: 'warn', file: 'src/new.ts', line: 2,
      message: 'login closely matches existing login at src/auth/login.ts:2 (similarity 1.00) — reuse instead of reimplementing.',
      related: { path: 'src/auth/login.ts', line: 2, name: 'login', score: 1 },
    },
    {
      kind: 'dangerous-edit', severity: 'warn', file: 'src/index.ts', line: 1,
      message: 'editing src/index.ts — entrypoint file (importer_count 0).',
    },
  ],
  blocked: false,
};

describe('validation report', () => {
  it('round-trips through the Zod schema', () => {
    expect(() => ValidationReportSchema.parse(report)).not.toThrow();
  });

  it('renders grouped human output', () => {
    const text = renderValidation(report);
    expect(text).toContain('DUPLICATE CANDIDATES:');
    expect(text).toContain('DANGEROUS EDITS:');
    expect(text).toContain('src/new.ts:2');
  });

  it('renders a clean run as "No findings."', () => {
    expect(renderValidation({ ...report, findings: [] })).toBe('No findings.');
  });

  it('writes last-validation.json', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-vr-'));
    writeValidation(work, report);
    const written = JSON.parse(fs.readFileSync(lastValidationJsonPath(work), 'utf8'));
    expect(written.findings).toHaveLength(2);
    fs.rmSync(work, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-report.test.ts`
Expected: FAIL — cannot find module `../src/validate/report.js`.

- [ ] **Step 3a: Add the path helper**

In `src/paths.ts`, add after the `agentRulesPath` line:

```ts
export const lastValidationJsonPath = (cwd: string) => path.join(senseiDir(cwd), 'last-validation.json');
```

- [ ] **Step 3b: Implement the report module**

Create `src/validate/report.ts`:

```ts
import { z } from 'zod';
import fs from 'node:fs';
import { senseiDir, lastValidationJsonPath } from '../paths.js';

export const FindingKindSchema = z.enum(['duplicate-candidate', 'dangerous-edit']);
export const SeveritySchema = z.enum(['warn', 'block']);

export const RelatedSymbolSchema = z.object({
  path: z.string(),
  line: z.number(),
  name: z.string(),
  score: z.number(),
});

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  severity: SeveritySchema,
  file: z.string(),
  line: z.number(),
  message: z.string(),
  related: RelatedSymbolSchema.optional(),
});

export const ValidationReportSchema = z.object({
  source: z.string(),
  generatedAt: z.string(),
  findings: z.array(FindingSchema),
  blocked: z.boolean(),
});

export type FindingKind = z.infer<typeof FindingKindSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

function renderGroup(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [];
  const lines = [`${title}:`];
  for (const f of findings) lines.push(`  ${f.file}:${f.line} — ${f.message}`);
  return lines;
}

export function renderValidation(report: ValidationReport): string {
  if (report.findings.length === 0) return 'No findings.';
  const dup = report.findings.filter((f) => f.kind === 'duplicate-candidate');
  const dang = report.findings.filter((f) => f.kind === 'dangerous-edit');
  const groups = [renderGroup('DUPLICATE CANDIDATES', dup), renderGroup('DANGEROUS EDITS', dang)]
    .filter((g) => g.length > 0);
  const lines = groups.flatMap((g, i) => (i === 0 ? g : ['', ...g]));
  if (report.blocked) lines.push('', `BLOCKED: ${report.findings.length} finding(s).`);
  return lines.join('\n');
}

export function writeValidation(cwd: string, report: ValidationReport): void {
  ValidationReportSchema.parse(report);
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(lastValidationJsonPath(cwd), JSON.stringify(report, null, 2) + '\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-report.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/paths.ts src/validate/report.ts test/validate-report.test.ts
git commit -m "feat: add validation report schema, render, and writer"
```

---

### Task 5: `validate/introduced.ts` — introduced-symbol detection

**Files:**
- Create: `src/validate/introduced.ts`
- Test: `test/validate-introduced.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/validate-introduced.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import { introducedSymbols } from '../src/validate/introduced.js';

function seed(): IndexDb {
  const db = new IndexDb(':memory:');
  db.migrate();
  const id = db.upsertFile({
    path: 'src/auth/login.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0,
  });
  db.insertSymbol(id, {
    kind: 'function', name: 'login', signature: 'login(email: string, password: string): boolean',
    exported: true, startLine: 2, jsdoc: '',
  }, 'src/auth/login.ts');
  return db;
}

describe('introducedSymbols', () => {
  it('treats a symbol already in the index (same name+kind+signature) as not introduced', () => {
    const db = seed();
    const source = 'export function login(email: string, password: string): boolean { return true; }\n';
    expect(introducedSymbols(db, 'src/auth/login.ts', source)).toEqual([]);
    db.close();
  });

  it('flags a brand-new symbol in an unindexed file as introduced', () => {
    const db = seed();
    const source = 'export function login(email: string, password: string): boolean { return false; }\n';
    const introduced = introducedSymbols(db, 'src/auth/relogin.ts', source);
    expect(introduced.map((s) => s.name)).toEqual(['login']);
    db.close();
  });

  it('flags a changed signature as introduced (new surface area)', () => {
    const db = seed();
    const source = 'export function login(token: string): boolean { return !!token; }\n';
    const introduced = introducedSymbols(db, 'src/auth/login.ts', source);
    expect(introduced.map((s) => s.signature)).toEqual(['login(token: string): boolean']);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-introduced.test.ts`
Expected: FAIL — cannot find module `../src/validate/introduced.js`.

- [ ] **Step 3: Implement**

Create `src/validate/introduced.ts`:

```ts
import type { IndexDb } from '../indexer/db.js';
import type { ExtractedSymbol } from '../types.js';
import { extractFromSource } from '../ast/extract.js';

const NUL = ' ';
const identity = (s: { kind: string; name: string; signature: string }): string =>
  `${s.kind}${NUL}${s.name}${NUL}${s.signature}`;

export function introducedSymbols(db: IndexDb, filePath: string, source: string): ExtractedSymbol[] {
  const known = new Set(db.symbolsForFile(filePath).map(identity));
  const { symbols } = extractFromSource(filePath, source);
  return symbols.filter((s) => !known.has(identity(s)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-introduced.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/validate/introduced.ts test/validate-introduced.test.ts
git commit -m "feat: detect introduced symbols vs the index"
```

---

### Task 6: `validate/checks.ts` — similarity + finding producers

**Files:**
- Create: `src/validate/checks.ts`
- Test: `test/validate-checks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/validate-checks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { symbolSimilarity, duplicateFindings, dangerousFindings } from '../src/validate/checks.js';
import type { ExtractedSymbol } from '../src/types.js';

const sym = (name: string, signature: string, startLine = 1): ExtractedSymbol =>
  ({ kind: 'function', name, signature, exported: true, startLine, jsdoc: '' });

function seedLogin(): IndexDb {
  const db = new IndexDb(':memory:');
  db.migrate();
  const id = db.upsertFile({
    path: 'src/auth/login.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0,
  });
  db.insertSymbol(id, sym('login', 'login(email: string, password: string): boolean', 2), 'src/auth/login.ts');
  return db;
}

describe('symbolSimilarity', () => {
  it('is 1.0 for identical name and signature', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(email: string, password: string): boolean' },
      { name: 'login', signature: 'login(email: string, password: string): boolean' },
    )).toBeCloseTo(1, 5);
  });

  it('caps a name-only match at 0.5', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(): void' },
      { name: 'login', signature: 'somethingElse(a: Foo, b: Bar): Baz' },
    )).toBeLessThanOrEqual(0.5);
  });
});

describe('duplicateFindings', () => {
  it('flags a same-name same-signature reimplementation in another file', () => {
    const db = seedLogin();
    const introduced = [sym('login', 'login(email: string, password: string): boolean', 1)];
    const out = duplicateFindings(db, DEFAULT_CONFIG, 'src/auth/relogin.ts', introduced, 'warn');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('duplicate-candidate');
    expect(out[0].related?.path).toBe('src/auth/login.ts');
    expect(out[0].related?.score).toBeGreaterThanOrEqual(DEFAULT_CONFIG.validate.duplicateThreshold);
    db.close();
  });

  it('excludes a match in the same file (moved/renamed self)', () => {
    const db = seedLogin();
    const introduced = [sym('login', 'login(email: string, password: string): boolean', 1)];
    expect(duplicateFindings(db, DEFAULT_CONFIG, 'src/auth/login.ts', introduced, 'warn')).toEqual([]);
    db.close();
  });

  it('does not flag a near-miss below threshold', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const id = db.upsertFile({ path: 'src/u.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    db.insertSymbol(id, sym('createUser', 'createUser(name: string): User', 1), 'src/u.ts');
    const introduced = [sym('createUserProfile', 'createUserProfile(name: string, age: number): Profile', 1)];
    expect(duplicateFindings(db, DEFAULT_CONFIG, 'src/p.ts', introduced, 'warn')).toEqual([]);
    db.close();
  });

  it('suppresses symbols whose name tokenizes to nothing', () => {
    const db = seedLogin();
    const introduced = [sym('x', 'x(): void', 1)];
    expect(duplicateFindings(db, DEFAULT_CONFIG, 'src/x.ts', introduced, 'warn')).toEqual([]);
    db.close();
  });
});

describe('dangerousFindings', () => {
  it('flags a changed entrypoint file', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile({ path: 'src/index.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    const out = dangerousFindings(db, DEFAULT_CONFIG, ['src/index.ts'], 'warn');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('dangerous-edit');
    expect(out[0].file).toBe('src/index.ts');
    db.close();
  });

  it('does not flag an ordinary changed file', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile({ path: 'src/util.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    expect(dangerousFindings(db, DEFAULT_CONFIG, ['src/util.ts'], 'warn')).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-checks.test.ts`
Expected: FAIL — cannot find module `../src/validate/checks.js`.

- [ ] **Step 3: Implement**

Create `src/validate/checks.ts`:

```ts
import type { IndexDb } from '../indexer/db.js';
import type { SenseiConfig } from '../config/schema.js';
import type { ExtractedSymbol } from '../types.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { findDangerousFiles } from '../scorer/score.js';
import type { Finding, Severity } from './report.js';

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

export function symbolSimilarity(
  a: { name: string; signature: string },
  b: { name: string; signature: string },
): number {
  const nameSim = jaccard(tokenize(a.name), tokenize(b.name));
  const sigSim = jaccard(tokenize(a.signature), tokenize(b.signature));
  return 0.5 * nameSim + 0.5 * sigSim;
}

export function duplicateFindings(
  db: IndexDb,
  config: SenseiConfig,
  changedFile: string,
  introduced: ExtractedSymbol[],
  severity: Severity,
): Finding[] {
  const threshold = config.validate.duplicateThreshold;
  const out: Finding[] = [];
  for (const symbol of introduced) {
    if (tokenize(symbol.name).length === 0) continue; // common-name suppression
    const best = searchSymbols(db, tokenize(`${symbol.name} ${symbol.signature}`))
      .filter((h) => h.path !== changedFile)
      .map((h) => ({
        path: h.path,
        line: h.start_line,
        name: h.name,
        score: symbolSimilarity(symbol, { name: h.name, signature: h.signature }),
      }))
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))[0];
    if (!best) continue;
    out.push({
      kind: 'duplicate-candidate',
      severity,
      file: changedFile,
      line: symbol.startLine,
      message: `${symbol.name} closely matches existing ${best.name} at ${best.path}:${best.line} (similarity ${best.score.toFixed(2)}) — reuse instead of reimplementing.`,
      related: best,
    });
  }
  return out;
}

export function dangerousFindings(
  db: IndexDb,
  config: SenseiConfig,
  changedFiles: string[],
  severity: Severity,
): Finding[] {
  const danger = new Map(findDangerousFiles(db, config).map((d) => [d.path, d]));
  const out: Finding[] = [];
  for (const file of changedFiles) {
    const d = danger.get(file);
    if (!d) continue;
    out.push({
      kind: 'dangerous-edit',
      severity,
      file,
      line: 1,
      message: `editing ${file} — ${d.reason} (importer_count ${d.importerCount}).`,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-checks.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/validate/checks.ts test/validate-checks.test.ts
git commit -m "feat: add duplicate + dangerous-edit checks with token-Jaccard similarity"
```

---

### Task 7: `core/run-validate-diff.ts` — orchestration

**Files:**
- Create: `src/core/run-validate-diff.ts`
- Test: `test/validate-e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/validate-e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runValidateDiff } from '../src/core/run-validate-diff.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');
const FIXED = new Date('2026-06-16T00:00:00Z');
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
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-vd-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('runValidateDiff (index-bound)', () => {
  it('flags a duplicate reimplementation and a dangerous entrypoint edit', async () => {
    fs.writeFileSync(
      path.join(work, 'src', 'auth', 'relogin.ts'),
      'export function login(email: string, password: string): boolean {\n  return Boolean(email) && Boolean(password);\n}\n',
    );
    fs.appendFileSync(path.join(work, 'src', 'index.ts'), '\n// touched\n');
    await simpleGit(work).add('.');

    const report = await runValidateDiff(work, { mode: 'staged' }, {}, FIXED);

    const dup = report.findings.find((f) => f.kind === 'duplicate-candidate');
    expect(dup?.file).toBe('src/auth/relogin.ts');
    expect(dup?.related?.path).toBe('src/auth/login.ts');

    const dang = report.findings.find((f) => f.kind === 'dangerous-edit');
    expect(dang?.file).toBe('src/index.ts');

    expect(report.blocked).toBe(false); // warn-only default
  });

  it('sets blocked=true under --block', async () => {
    const report = await runValidateDiff(work, { mode: 'staged' }, { block: true }, FIXED);
    expect(report.blocked).toBe(true);
  });

  it('errors clearly when no index exists', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-noidx-'));
    await simpleGit(fresh).init();
    await expect(runValidateDiff(fresh, { mode: 'staged' })).rejects.toThrow(/Run `sensei scan` first/);
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-e2e.test.ts`
Expected: FAIL — cannot find module `../src/core/run-validate-diff.js`.

- [ ] **Step 3: Implement**

Create `src/core/run-validate-diff.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import { dbPath } from '../paths.js';
import { changedFiles, type DiffSource } from '../validate/diff.js';
import { introducedSymbols } from '../validate/introduced.js';
import { duplicateFindings, dangerousFindings } from '../validate/checks.js';
import { writeValidation, type Finding, type ValidationReport } from '../validate/report.js';

export interface ValidateOptions {
  block?: boolean;
}

export async function runValidateDiff(
  cwd: string,
  source: DiffSource,
  opts: ValidateOptions = {},
  now: Date = new Date(),
): Promise<ValidationReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const blocking = opts.block ?? config.validate.block;
  const severity: Finding['severity'] = blocking ? 'block' : 'warn';
  const files = await changedFiles(cwd, source);

  const db = new IndexDb(dbPath(cwd));
  try {
    const findings: Finding[] = [];
    if (config.validate.checkDuplicates) {
      for (const file of files) {
        const abs = path.join(cwd, file);
        let content: string;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch {
          continue; // deleted/unreadable in working tree
        }
        const introduced = introducedSymbols(db, file, content);
        findings.push(...duplicateFindings(db, config, file, introduced, severity));
      }
    }
    if (config.validate.checkDangerous) {
      findings.push(...dangerousFindings(db, config, files, severity));
    }

    const sourceLabel = source.mode === 'against' ? source.ref : source.mode;
    const report: ValidationReport = {
      source: sourceLabel,
      generatedAt: now.toISOString(),
      findings,
      blocked: blocking && findings.length > 0,
    };
    writeValidation(cwd, report);
    return report;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-e2e.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/core/run-validate-diff.ts test/validate-e2e.test.ts
git commit -m "feat: orchestrate validate-diff (changed files -> findings -> report)"
```

---

### Task 8: `commands/validate-diff.ts` — oclif command

**Files:**
- Create: `src/commands/validate-diff.ts`

- [ ] **Step 1: Implement the command**

Create `src/commands/validate-diff.ts`:

```ts
import { Command, Flags } from '@oclif/core';
import { runValidateDiff } from '../core/run-validate-diff.js';
import { renderValidation, type ValidationReport } from '../validate/report.js';
import type { DiffSource } from '../validate/diff.js';
import { lastValidationJsonPath } from '../paths.js';

export default class ValidateDiff extends Command {
  static description = 'Check changed files against the index for duplication and dangerous edits.';
  static examples = [
    '<%= config.bin %> validate-diff',
    '<%= config.bin %> validate-diff --against main --block',
  ];
  static flags = {
    staged: Flags.boolean({ description: 'Check staged changes (default).', default: false }),
    all: Flags.boolean({ description: 'Check all working-tree changes vs HEAD.', default: false }),
    against: Flags.string({ description: 'Check changes in <ref>...HEAD.' }),
    block: Flags.boolean({ description: 'Exit non-zero if any finding.', default: false }),
    json: Flags.boolean({ description: 'Emit the JSON report.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ValidateDiff);
    const source: DiffSource = flags.against
      ? { mode: 'against', ref: flags.against }
      : flags.all
        ? { mode: 'all' }
        : { mode: 'staged' };

    let report: ValidationReport;
    try {
      report = await runValidateDiff(process.cwd(), source, { block: flags.block || undefined });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    }

    if (flags.json) {
      this.log(JSON.stringify(report, null, 2));
    } else {
      this.log(renderValidation(report));
      this.log(`Report: ${lastValidationJsonPath(process.cwd())}`);
    }
    if (report.blocked) this.exit(1);
  }
}
```

- [ ] **Step 2: Build and smoke-test the binary (exit codes)**

Run:
```bash
npm run build
SMOKE=$(mktemp -d) && cp -r test/fixtures/sample-repo/. "$SMOKE" && cd "$SMOKE" \
  && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base \
  && node "$OLDPWD/bin/run.js" init >/dev/null \
  && node "$OLDPWD/bin/run.js" scan >/dev/null \
  && printf 'export function login(email: string, password: string): boolean {\n  return Boolean(email) && Boolean(password);\n}\n' > src/auth/relogin.ts \
  && git add -A \
  && node "$OLDPWD/bin/run.js" validate-diff --staged; echo "warn-exit=$?" \
  && node "$OLDPWD/bin/run.js" validate-diff --staged --block; echo "block-exit=$?"; cd "$OLDPWD"
```
Expected: first run prints `DUPLICATE CANDIDATES:` and `warn-exit=0`; second prints the same plus `BLOCKED:` and `block-exit=1`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/validate-diff.ts
git commit -m "feat: add validate-diff oclif command"
```

---

### Task 9: `guard/hook.ts` — managed-block hook writer

**Files:**
- Create: `src/guard/hook.ts`
- Test: `test/guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/guard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { installHook, uninstallHook } from '../src/guard/hook.js';

let work: string;

beforeEach(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-guard-'));
  await simpleGit(work).init();
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

describe('installHook', () => {
  it('writes a runnable, idempotent warn-only pre-commit hook', async () => {
    const file = await installHook(work, 'pre-commit', false);
    expect(file.endsWith(path.join('hooks', 'pre-commit'))).toBe(true);
    let content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith('#!/bin/sh')).toBe(true);
    expect(content).toContain('validate-diff --staged');
    expect(content).toContain('|| exit 0');
    expect(fs.statSync(file).mode & 0o111).toBeGreaterThan(0); // executable

    await installHook(work, 'pre-commit', false); // re-install
    content = fs.readFileSync(file, 'utf8');
    expect(content.match(/# >>> sensei guard >>>/g)).toHaveLength(1); // not duplicated
  });

  it('preserves existing hook content and supports blocking mode', async () => {
    const dir = path.join(work, '.git', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\necho custom\n');
    const file = await installHook(work, 'pre-commit', true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('echo custom');
    expect(content).toContain('validate-diff --staged --block');
    expect(content).not.toContain('|| exit 0');
  });

  it('throws outside a git repository', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ng-'));
    await expect(installHook(nonRepo, 'pre-commit', false)).rejects.toThrow(/Not a git repository/);
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});

describe('uninstallHook', () => {
  it('removes only the sensei block', async () => {
    const dir = path.join(work, '.git', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\necho custom\n');
    await installHook(work, 'pre-commit', false);
    expect(await uninstallHook(work, 'pre-commit')).toBe(true);
    const content = fs.readFileSync(path.join(dir, 'pre-commit'), 'utf8');
    expect(content).toContain('echo custom');
    expect(content).not.toContain('sensei guard');
    expect(await uninstallHook(work, 'pre-commit')).toBe(false); // nothing left to remove
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/guard.test.ts`
Expected: FAIL — cannot find module `../src/guard/hook.js`.

- [ ] **Step 3: Implement**

Create `src/guard/hook.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export type HookName = 'pre-commit' | 'pre-push';

const BEGIN = '# >>> sensei guard >>>';
const END = '# <<< sensei guard <<<';
const SHEBANG = '#!/bin/sh';

async function hooksDir(cwd: string): Promise<string> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) throw new Error('Not a git repository.');
  const rel = (await git.raw(['rev-parse', '--git-path', 'hooks'])).trim();
  return path.isAbsolute(rel) ? rel : path.join(cwd, rel);
}

function senseiInvocation(cwd: string): string {
  const local = path.join(cwd, 'node_modules', '.bin', 'sensei');
  return fs.existsSync(local) ? local : 'sensei';
}

function managedBlock(cwd: string, hook: HookName, block: boolean): string {
  const inv = senseiInvocation(cwd);
  const cmd = hook === 'pre-push'
    ? `${inv} validate-diff --against @{upstream}`
    : `${inv} validate-diff --staged`;
  const line = block ? `${cmd} --block` : `${cmd} || exit 0`;
  return [BEGIN, line, END].join('\n');
}

function stripBlock(content: string): string {
  const lines = content.split('\n');
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (start === -1 || end === -1 || end < start) return content;
  lines.splice(start, end - start + 1);
  if (lines[start] === '' && (start === 0 || lines[start - 1] === '')) lines.splice(start, 1);
  return lines.join('\n');
}

export async function installHook(cwd: string, hook: HookName, block: boolean): Promise<string> {
  const dir = await hooksDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, hook);
  const exists = fs.existsSync(file);
  const base = exists ? stripBlock(fs.readFileSync(file, 'utf8')) : `${SHEBANG}\n`;
  const sep = base.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${base}${sep}${managedBlock(cwd, hook, block)}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

export async function uninstallHook(cwd: string, hook: HookName): Promise<boolean> {
  const dir = await hooksDir(cwd);
  const file = path.join(dir, hook);
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, 'utf8');
  if (!current.includes(BEGIN)) return false;
  fs.writeFileSync(file, stripBlock(current));
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/guard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/guard/hook.ts test/guard.test.ts
git commit -m "feat: add guard git-hook writer (managed block, idempotent)"
```

---

### Task 10: `core/run-guard.ts` + `commands/guard.ts`

**Files:**
- Create: `src/core/run-guard.ts`
- Create: `src/commands/guard.ts`

- [ ] **Step 1: Implement the orchestrator**

Create `src/core/run-guard.ts`:

```ts
import { installHook, uninstallHook, type HookName } from '../guard/hook.js';
import { runValidateDiff } from './run-validate-diff.js';
import { renderValidation } from '../validate/report.js';

export type GuardAction = 'install' | 'uninstall' | 'run';

export interface GuardOptions {
  hook: HookName;
  block: boolean;
}

export async function runGuard(cwd: string, action: GuardAction, opts: GuardOptions): Promise<string> {
  if (action === 'install') {
    const file = await installHook(cwd, opts.hook, opts.block);
    return `Installed ${opts.hook} hook (${opts.block ? 'blocking' : 'warn-only'}): ${file}`;
  }
  if (action === 'uninstall') {
    const removed = await uninstallHook(cwd, opts.hook);
    return removed
      ? `Removed sensei block from ${opts.hook} hook.`
      : `No sensei block found in ${opts.hook} hook.`;
  }
  const report = await runValidateDiff(cwd, { mode: 'staged' }, { block: opts.block || undefined });
  return renderValidation(report);
}
```

- [ ] **Step 2: Implement the command**

Create `src/commands/guard.ts`:

```ts
import { Args, Command, Flags } from '@oclif/core';
import { runGuard, type GuardAction } from '../core/run-guard.js';
import type { HookName } from '../guard/hook.js';

export default class Guard extends Command {
  static description = 'Install/uninstall a git hook that runs validate-diff, or run it directly.';
  static examples = [
    '<%= config.bin %> guard install',
    '<%= config.bin %> guard install --hook pre-push --block',
    '<%= config.bin %> guard uninstall',
  ];
  static args = {
    action: Args.string({ description: 'install | uninstall | run', required: true, options: ['install', 'uninstall', 'run'] }),
  };
  static flags = {
    hook: Flags.string({ description: 'Hook to manage.', options: ['pre-commit', 'pre-push'], default: 'pre-commit' }),
    block: Flags.boolean({ description: 'Make the hook block (fail) on findings.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Guard);
    const msg = await runGuard(process.cwd(), args.action as GuardAction, {
      hook: flags.hook as HookName,
      block: flags.block,
    });
    this.log(msg);
  }
}
```

- [ ] **Step 3: Build and smoke-test guard**

Run:
```bash
npm run build
SMOKE=$(mktemp -d) && cp -r test/fixtures/sample-repo/. "$SMOKE" && cd "$SMOKE" \
  && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base \
  && node "$OLDPWD/bin/run.js" init >/dev/null && node "$OLDPWD/bin/run.js" scan >/dev/null \
  && node "$OLDPWD/bin/run.js" guard install \
  && test -x .git/hooks/pre-commit && echo "hook-installed=ok" \
  && node "$OLDPWD/bin/run.js" guard uninstall \
  && ! grep -q 'sensei guard' .git/hooks/pre-commit && echo "hook-removed=ok"; cd "$OLDPWD"
```
Expected: prints the install message, `hook-installed=ok`, the uninstall message, and `hook-removed=ok`.

- [ ] **Step 4: Commit**

```bash
git add src/core/run-guard.ts src/commands/guard.ts
git commit -m "feat: add guard command (install/uninstall/run)"
```

---

### Task 11: Docs + full verification + finish

**Files:**
- Modify: `README.md` (document the two new commands)

- [ ] **Step 1: Document the commands**

In `README.md`, add a section after the existing command docs:

````markdown
## Enforcement

After your agent writes code, check the diff against the index:

```bash
sensei validate-diff            # check staged changes (warn-only)
sensei validate-diff --against main   # check this branch vs main
sensei validate-diff --block    # exit non-zero on any finding (for CI/hooks)
```

Findings: **duplicate-candidate** (a new symbol closely matches existing code — reuse it) and **dangerous-edit** (you touched a high-fan-in or entrypoint file). The JSON form is written to `.sensei/last-validation.json`.

Install it as a git hook so it runs automatically:

```bash
sensei guard install                  # warn-only pre-commit hook
sensei guard install --block          # block commits on findings
sensei guard install --hook pre-push  # run on push instead
sensei guard uninstall
```

The hook never breaks your commit on a tooling error (missing index, parse failure) unless you installed it with `--block`.
````

- [ ] **Step 2: Run the full suite + typecheck + build**

Run:
```bash
npm run typecheck && npm test && npm run build
```
Expected: typecheck clean; all tests pass (the MVP's tests plus the new `validate-*` and `guard` suites); build emits `dist/`.

- [ ] **Step 3: Confirm no forbidden type escape hatches**

Run: `rg -n "as unknown as|: any|as any" src/`
Expected: no matches (clean-code compliance).

- [ ] **Step 4: Commit docs**

```bash
git add README.md
git commit -m "docs: document validate-diff and guard"
```

- [ ] **Step 5: Finish the development branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this work." Then follow superpowers:finishing-a-development-branch (verify tests, present options, execute the chosen workflow).

---

## Self-Review Notes (author)

- **Spec coverage:** §2 binding model → Tasks 4–7 (index-bound, no report dependency). §3 commands/flags → Tasks 8, 10. §4 engine steps → diff (T3), introduced (T5), duplicate+dangerous checks (T6), assembly (T7). §5 finding model → T4. §6 config → T1. §7 exit policy → T7 (`blocked`) + T8 (`this.exit`). §8 freshness (missing index hard error) → T7. §9 hook mechanics → T9. §11 false-positive mitigations (signature weight, common-name suppression, warn-only, same-file exclusion) → T6 tests. §12 error handling → T3 (non-repo), T7 (unreadable file skip). §13 testing → every task is TDD; E2E in T7.
- **Type consistency:** `DiffSource`, `Finding`, `Severity`, `ValidationReport` defined once (T3/T4) and imported everywhere; `runValidateDiff(cwd, source, opts, now)` signature stable across T7/T8/T10.
- **Reuse, not reinvention:** T5 reuses `extractFromSource`; T6 reuses `searchSymbols` + `findDangerousFiles` + `tokenize`; T7 reuses `loadConfig` + `IndexDb`. Only new logic is the token-Jaccard `symbolSimilarity` (justified in spec §4.5).
- **Deferred (out of scope):** `validate-plan`, GitHub Action, embeddings, multi-language, report-bound checks, pure-deletion handling.
```
