# validate-plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sensei validate-plan <plan.md>` — parse an agent's free-text plan into proposed files/symbols and flag reuse violations and dangerous-path targets against the existing index, before any code is written.

**Architecture:** Index-bound, standalone (needs `sensei scan`, not a prior `context` run). A hybrid parser (`plan-parse.ts`) turns plan markdown into `ProposedTarget[]`; a pluggable check registry (`plan-checks.ts`) runs `reuse-candidate` (name-containment vs index) and `dangerous-target` (glob ∪ index map) producers; findings reuse the shared `validate-diff` `ValidationReport` schema and render, written to a separate `.sensei/last-plan-validation.json`. Mirrors the established `commands → core → validate` layering.

**Tech Stack:** TypeScript (ESM, NodeNext), oclif commands, better-sqlite3 index, zod schemas, `ignore` for glob matching, vitest. Source of truth design: `docs/superpowers/specs/2026-06-16-sensei-validate-plan-design.md`.

**Conventions to follow (verified in repo):**
- All intra-repo imports use the `.js` extension (e.g. `from '../text/tokenize.js'`).
- Tests live in `test/*.test.ts`, import from `../src/...js`, use `vitest` (`describe/it/expect`).
- In-memory index for unit tests: `const db = new IndexDb(':memory:'); db.migrate();` then `db.upsertFile({...})` / `db.insertSymbol(fileId, symbol, path)`.
- `tokenize` (in `src/text/tokenize.ts`) lowercases, splits camelCase, drops tokens `< 2` chars and a stopword set that includes `create/add/new/update/implement/support/feature/use/build/make/handle/...`.
- Determinism: every list output is sorted explicitly.

---

## File Structure

**New files:**
- `src/validate/similarity.ts` — shared token comparison (`jaccard`, `symbolSimilarity`, `nameContainment`).
- `src/validate/glob.ts` — `firstDangerousMatch(path, patterns)` wrapping the `ignore` dep.
- `src/validate/plan-parse.ts` — `parsePlan(text) → ProposedTarget[]` (structured + heuristic hybrid).
- `src/validate/plan-checks.ts` — `PlanCheck` registry + `runPlanChecks(ctx)` (reuse-candidate, dangerous-target).
- `src/core/run-validate-plan.ts` — orchestrator: load config, open index, parse, run checks, write report.
- `src/commands/validate-plan.ts` — thin oclif command (positional `plan`, `--stdin/--block/--json`).
- Tests: `test/validate-similarity.test.ts`, `test/validate-glob.test.ts`, `test/validate-plan-parse.test.ts`, `test/validate-plan-checks.test.ts`, `test/validate-plan-report.test.ts`, `test/validate-plan-e2e.test.ts`. Config assertions appended to `test/config.test.ts`.

**Modified files:**
- `src/config/schema.ts` — add `dangerous.paths: string[]` (default `[]`).
- `src/paths.ts` — add `lastPlanValidationJsonPath`.
- `src/validate/checks.ts` — move `jaccard`/`symbolSimilarity` to `similarity.ts`; re-export `symbolSimilarity`.
- `src/validate/report.ts` — extend `FindingKindSchema`; generalize `renderValidation` grouping; add `writePlanValidation`.
- `README.md` — document `validate-plan`, update Roadmap.

---

## Task 1: Config — add `dangerous.paths`

**Files:**
- Modify: `src/config/schema.ts:25-27`
- Test: `test/config.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `test/config.test.ts`, after the existing tests, before the final closing if any — these are standalone `it`/`describe` blocks using the already-imported `ConfigSchema`; if `ConfigSchema` is not imported in this file, add `import { ConfigSchema } from '../src/config/schema.js';` at the top)

```ts
describe('dangerous.paths', () => {
  it('defaults to an empty array', () => {
    expect(ConfigSchema.parse({}).dangerous.paths).toEqual([]);
  });

  it('accepts gitignore-style globs', () => {
    const c = ConfigSchema.parse({ dangerous: { paths: ['src/auth/**', 'prisma/migrations/**'] } });
    expect(c.dangerous.paths).toEqual(['src/auth/**', 'prisma/migrations/**']);
  });

  it('still defaults importerThreshold alongside paths', () => {
    const c = ConfigSchema.parse({ dangerous: { paths: ['x/**'] } });
    expect(c.dangerous.importerThreshold).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `dangerous.paths` is `undefined` (key not in schema).

- [ ] **Step 3: Implement** — replace the `dangerous` block in `src/config/schema.ts` (currently lines 25-27):

```ts
  dangerous: z
    .object({
      importerThreshold: z.number().int().positive().default(5),
      paths: z.array(z.string()).default([]),
    })
    .default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config.test.ts
git commit -m "feat(config): add dangerous.paths glob list"
```

---

## Task 2: Glob matcher — `src/validate/glob.ts`

**Files:**
- Create: `src/validate/glob.ts`
- Test: `test/validate-glob.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/validate-glob.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { firstDangerousMatch } from '../src/validate/glob.js';

describe('firstDangerousMatch', () => {
  it('returns the matching glob for a path under it', () => {
    expect(firstDangerousMatch('src/auth/login.ts', ['src/auth/**'])).toBe('src/auth/**');
  });

  it('returns null when nothing matches', () => {
    expect(firstDangerousMatch('src/util/x.ts', ['src/auth/**', 'prisma/**'])).toBeNull();
  });

  it('returns null for an empty pattern list', () => {
    expect(firstDangerousMatch('src/auth/login.ts', [])).toBeNull();
  });

  it('matches a bare filename glob', () => {
    expect(firstDangerousMatch('package.json', ['package.json'])).toBe('package.json');
  });

  it('reports the first matching pattern when several match', () => {
    expect(firstDangerousMatch('src/auth/login.ts', ['src/**', 'src/auth/**'])).toBe('src/**');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-glob.test.ts`
Expected: FAIL — module `../src/validate/glob.js` not found.

- [ ] **Step 3: Implement** — create `src/validate/glob.ts`:

```ts
import ignore from 'ignore';

/**
 * Return the first gitignore-style pattern in `patterns` that matches
 * `filePath` (repo-relative, posix), or null if none match.
 * Patterns are tested individually so the matched pattern can be reported.
 */
export function firstDangerousMatch(filePath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (ignore().add(pattern).ignores(filePath)) return pattern;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-glob.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate/glob.ts test/validate-glob.test.ts
git commit -m "feat(validate): add dangerous-path glob matcher"
```

---

## Task 3: Shared similarity — `src/validate/similarity.ts`

Extract `jaccard`/`symbolSimilarity` out of `checks.ts` into `similarity.ts`, add `nameContainment`, and re-export `symbolSimilarity` from `checks.ts` so existing importers keep working.

**Files:**
- Create: `src/validate/similarity.ts`
- Modify: `src/validate/checks.ts:9-26` (remove local `jaccard`/`symbolSimilarity`, import + re-export)
- Test: `test/validate-similarity.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/validate-similarity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { symbolSimilarity, nameContainment } from '../src/validate/similarity.js';

describe('symbolSimilarity (unchanged 50/50)', () => {
  it('is 1.0 for identical name and signature', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(email: string): boolean' },
      { name: 'login', signature: 'login(email: string): boolean' },
    )).toBeCloseTo(1, 5);
  });

  it('caps a name-only match at 0.5', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(): void' },
      { name: 'login', signature: 'other(a: Foo, b: Bar): Baz' },
    )).toBeLessThanOrEqual(0.5);
  });
});

describe('nameContainment', () => {
  it('is 1.0 when the proposed name contains all of an existing multi-token name', () => {
    expect(nameContainment('PartialRefundService', 'RefundService')).toBeCloseTo(1, 5);
  });

  it('is below threshold for a single shared token of a multi-token name', () => {
    expect(nameContainment('PaymentService', 'RefundService')).toBeCloseTo(0.5, 5);
  });

  it('returns 0 for a single-token existing name unless matched exactly', () => {
    expect(nameContainment('validatePlan', 'validate')).toBe(0);
    expect(nameContainment('validate', 'validate')).toBe(1);
  });

  it('returns 0 when either side tokenizes to nothing', () => {
    expect(nameContainment('x', 'RefundService')).toBe(0);
    expect(nameContainment('RefundService', 'a')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-similarity.test.ts`
Expected: FAIL — module `../src/validate/similarity.js` not found.

- [ ] **Step 3: Create `src/validate/similarity.ts`:**

```ts
import { tokenize } from '../text/tokenize.js';

/** Symmetric token-Jaccard of two token lists. */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

/** 50/50 name+signature similarity. Used where the signature is known (diff). */
export function symbolSimilarity(
  a: { name: string; signature: string },
  b: { name: string; signature: string },
): number {
  const nameSim = jaccard(tokenize(a.name), tokenize(b.name));
  const sigSim = jaccard(tokenize(a.signature), tokenize(b.signature));
  return 0.5 * nameSim + 0.5 * sigSim;
}

/**
 * Fraction of an existing symbol's meaningful tokens echoed by a proposed name.
 * Used by validate-plan, where a proposal has a name but no signature yet.
 * Single-token existing names only match an exact single-token proposal,
 * suppressing common short names (validate, index, handler).
 */
export function nameContainment(proposedName: string, existingName: string): number {
  const proposed = new Set(tokenize(proposedName));
  const existing = tokenize(existingName);
  if (proposed.size === 0 || existing.length === 0) return 0;
  let inter = 0;
  for (const t of existing) if (proposed.has(t)) inter += 1;
  if (existing.length === 1) return inter === 1 && proposed.size === 1 ? 1 : 0;
  return inter / existing.length;
}
```

- [ ] **Step 4: Update `src/validate/checks.ts`** — remove the local `jaccard` (lines 9-17) and `symbolSimilarity` (lines 19-26), and replace with an import + re-export. The top of the file becomes:

```ts
import type { IndexDb } from '../indexer/db.js';
import type { SenseiConfig } from '../config/schema.js';
import type { ExtractedSymbol } from '../types.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { findDangerousFiles } from '../scorer/score.js';
import { symbolSimilarity } from './similarity.js';
import type { Finding, Severity } from './report.js';

export { symbolSimilarity } from './similarity.js';
```

Leave `duplicateFindings` and `dangerousFindings` (and their use of `symbolSimilarity`, `tokenize`, `searchSymbols`, `findDangerousFiles`) exactly as they were below this import block.

- [ ] **Step 5: Run tests to verify the extraction is green**

Run: `npx vitest run test/validate-similarity.test.ts test/validate-checks.test.ts`
Expected: PASS — new similarity tests pass; the existing `validate-checks.test.ts` (which imports `symbolSimilarity` from `../src/validate/checks.js`) still resolves and passes via the re-export.

- [ ] **Step 6: Commit**

```bash
git add src/validate/similarity.ts src/validate/checks.ts test/validate-similarity.test.ts
git commit -m "refactor(validate): extract similarity helpers; add nameContainment"
```

---

## Task 4: Report schema extension + plan writer

**Files:**
- Modify: `src/paths.ts:10` (append)
- Modify: `src/validate/report.ts` (extend enum, generalize render, add writer)
- Test: `test/validate-plan-report.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/validate-plan-report.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ValidationReportSchema,
  renderValidation,
  writePlanValidation,
  type ValidationReport,
} from '../src/validate/report.js';
import { lastPlanValidationJsonPath, lastValidationJsonPath } from '../src/paths.js';

const report: ValidationReport = {
  source: 'plan',
  generatedAt: '2026-06-16T00:00:00.000Z',
  findings: [
    { kind: 'reuse-candidate', severity: 'warn', file: 'PartialRefundService', line: 5,
      message: 'extend RefundService instead', related: { path: 'src/refund.ts', line: 2, name: 'RefundService', score: 1 } },
    { kind: 'dangerous-target', severity: 'warn', file: 'src/auth/oauth.ts', line: 9,
      message: 'matches dangerous path' },
  ],
  blocked: false,
};

let work: string | undefined;
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); work = undefined; });

describe('plan report', () => {
  it('accepts the new finding kinds and source plan', () => {
    expect(() => ValidationReportSchema.parse(report)).not.toThrow();
  });

  it('renders REUSE CANDIDATES then DANGEROUS TARGETS groups', () => {
    const out = renderValidation(report);
    expect(out.indexOf('REUSE CANDIDATES')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('DANGEROUS TARGETS')).toBeGreaterThan(out.indexOf('REUSE CANDIDATES'));
  });

  it('writes the separate plan report file without touching last-validation.json', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-plan-report-'));
    writePlanValidation(work, report);
    expect(fs.existsSync(lastPlanValidationJsonPath(work))).toBe(true);
    expect(fs.existsSync(lastValidationJsonPath(work))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-plan-report.test.ts`
Expected: FAIL — `writePlanValidation` / `lastPlanValidationJsonPath` not exported; enum rejects `reuse-candidate`.

- [ ] **Step 3: Add the path** — append to `src/paths.ts` (after line 10):

```ts
export const lastPlanValidationJsonPath = (cwd: string) => path.join(senseiDir(cwd), 'last-plan-validation.json');
```

- [ ] **Step 4: Extend `src/validate/report.ts`.** Make three edits:

(a) Replace the `FindingKindSchema` line (currently line 5):

```ts
export const FindingKindSchema = z.enum([
  'duplicate-candidate',
  'dangerous-edit',
  'reuse-candidate',
  'dangerous-target',
]);
```

(b) Replace the `renderValidation` function (currently lines 43-52) with a kind-driven grouping that preserves the existing diff order and adds the plan groups:

```ts
const GROUP_TITLES: ReadonlyArray<readonly [FindingKind, string]> = [
  ['duplicate-candidate', 'DUPLICATE CANDIDATES'],
  ['reuse-candidate', 'REUSE CANDIDATES'],
  ['dangerous-edit', 'DANGEROUS EDITS'],
  ['dangerous-target', 'DANGEROUS TARGETS'],
];

export function renderValidation(report: ValidationReport): string {
  if (report.findings.length === 0) return 'No findings.';
  const groups = GROUP_TITLES
    .map(([kind, title]) => renderGroup(title, report.findings.filter((f) => f.kind === kind)))
    .filter((g) => g.length > 0);
  const lines = groups.flatMap((g, i) => (i === 0 ? g : ['', ...g]));
  if (report.blocked) lines.push('', `BLOCKED: ${report.findings.length} finding(s).`);
  return lines.join('\n');
}
```

(c) Replace the `writeValidation` function (currently lines 54-58) with a shared writer plus both public writers, and update the import on line 3 to include the plan path:

Update line 3 import:
```ts
import { senseiDir, lastValidationJsonPath, lastPlanValidationJsonPath } from '../paths.js';
```

Replace the writer:
```ts
function writeReport(targetPath: string, cwd: string, report: ValidationReport): void {
  ValidationReportSchema.parse(report);
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(report, null, 2) + '\n');
}

export function writeValidation(cwd: string, report: ValidationReport): void {
  writeReport(lastValidationJsonPath(cwd), cwd, report);
}

export function writePlanValidation(cwd: string, report: ValidationReport): void {
  writeReport(lastPlanValidationJsonPath(cwd), cwd, report);
}
```

- [ ] **Step 5: Run tests to verify pass + no regression**

Run: `npx vitest run test/validate-plan-report.test.ts test/validate-report.test.ts`
Expected: PASS — new plan-report tests pass; existing `validate-report.test.ts` still passes (diff grouping unchanged for its two kinds).

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts src/validate/report.ts test/validate-plan-report.test.ts
git commit -m "feat(validate): extend report schema/render for plan findings"
```

---

## Task 5: Plan parser — `src/validate/plan-parse.ts`

**Files:**
- Create: `src/validate/plan-parse.ts`
- Test: `test/validate-plan-parse.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/validate-plan-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePlan } from '../src/validate/plan-parse.js';

describe('parsePlan — structured sections', () => {
  it('extracts file targets from a "Files to Create" section with create action', () => {
    const plan = [
      '## Files to Create',
      '- `src/payments/refund-v2.service.ts`',
      '- src/payments/refund.repository.ts',
    ].join('\n');
    const files = parsePlan(plan).filter((t) => t.kind === 'file');
    expect(files.map((f) => f.value).sort()).toEqual([
      'src/payments/refund-v2.service.ts',
      'src/payments/refund.repository.ts',
    ]);
    expect(files.every((f) => f.action === 'create' && f.confidence === 'high')).toBe(true);
  });

  it('extracts symbol targets from a "New Symbols" section', () => {
    const plan = ['### New Symbols', '- `PartialRefundService`', '- createPartialRefund()'].join('\n');
    const syms = parsePlan(plan).filter((t) => t.kind === 'symbol');
    expect(syms.map((s) => s.value).sort()).toEqual(['PartialRefundService', 'createPartialRefund']);
    expect(syms.every((s) => s.confidence === 'high')).toBe(true);
  });
});

describe('parsePlan — heuristic fallback', () => {
  it('finds a file path and a PascalCase symbol in prose', () => {
    const plan = 'We will create RefundManager in `src/payments/manager.ts` to own refunds.';
    const targets = parsePlan(plan);
    expect(targets.find((t) => t.kind === 'file')?.value).toBe('src/payments/manager.ts');
    const sym = targets.find((t) => t.kind === 'symbol' && t.value === 'RefundManager');
    expect(sym).toBeDefined();
    expect(sym?.action).toBe('create');
  });

  it('suppresses prose words that tokenize to nothing', () => {
    const plan = 'Create the New Feature and Update the System.';
    expect(parsePlan(plan).filter((t) => t.kind === 'symbol')).toEqual([]);
  });
});

describe('parsePlan — merge + action', () => {
  it('dedupes a path appearing in both structured and prose, keeping high confidence', () => {
    const plan = [
      'First we touch `src/payments/refund.service.ts`.',
      '',
      '## Files to Modify',
      '- `src/payments/refund.service.ts`',
    ].join('\n');
    const hits = parsePlan(plan).filter((t) => t.kind === 'file' && t.value === 'src/payments/refund.service.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0].confidence).toBe('high');
    expect(hits[0].action).toBe('modify');
  });

  it('infers modify when a modify verb is present', () => {
    const targets = parsePlan('We will extend RefundService with a new branch.');
    expect(targets.find((t) => t.value === 'RefundService')?.action).toBe('modify');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-plan-parse.test.ts`
Expected: FAIL — module `../src/validate/plan-parse.js` not found.

- [ ] **Step 3: Implement** — create `src/validate/plan-parse.ts`:

```ts
import { tokenize } from '../text/tokenize.js';

export interface ProposedTarget {
  kind: 'file' | 'symbol';
  value: string;                       // posix path (file) or symbol name (symbol)
  action: 'create' | 'modify' | 'unknown';
  line: number;                        // 1-based line in the plan
  confidence: 'high' | 'low';          // high = structured section, low = heuristic
}

const CREATE_VERBS = ['create', 'add', 'new', 'introduce', 'scaffold', 'generate', 'implement'];
const MODIFY_VERBS = ['modify', 'change', 'edit', 'update', 'extend', 'reuse', 'refactor'];

const HEADER = /^#{1,6}\s+/;
const FILE_HEADER = /^#{1,6}\s+(.*\bfiles?\b.*)$/i;
const SYMBOL_HEADER = /^#{1,6}\s+(.*\b(?:symbols?|functions?|classes|methods?)\b.*)$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;

const FILE_PATH = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx)\b/g;
const BACKTICK_SYMBOL = /`([A-Za-z_$][\w$.]*?)\(?\)?`/g;
const PASCAL = /\b[A-Z][A-Za-z0-9]{2,}\b/g;
const CALL = /\b([a-z_$][\w$]*)\(/g;

function hasWord(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

function inferAction(text: string): ProposedTarget['action'] {
  if (hasWord(text, MODIFY_VERBS)) return 'modify';
  if (hasWord(text, CREATE_VERBS)) return 'create';
  return 'unknown';
}

function firstFilePath(text: string): string | null {
  const m = text.match(FILE_PATH);
  return m ? m[0] : null;
}

function cleanSymbol(raw: string): string {
  return raw.replace(/\(\)$/, '');
}

function firstSymbol(text: string): string | null {
  const bt = text.match(/`([A-Za-z_$][\w$.]*?)\(?\)?`/);
  if (bt) {
    const s = cleanSymbol(bt[1]);
    if (tokenize(s).length > 0) return s;
  }
  const pascal = text.match(/\b[A-Z][A-Za-z0-9]{2,}\b/);
  if (pascal && tokenize(pascal[0]).length > 0) return pascal[0];
  const call = text.match(/\b([a-z_$][\w$]*)\(/);
  if (call && tokenize(call[1]).length > 0) return call[1];
  return null;
}

function heuristicSymbols(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(BACKTICK_SYMBOL)) {
    const s = cleanSymbol(m[1]);
    if (tokenize(s).length > 0) found.add(s);
  }
  for (const m of text.matchAll(PASCAL)) {
    if (tokenize(m[0]).length > 0) found.add(m[0]);
  }
  for (const m of text.matchAll(CALL)) {
    if (tokenize(m[1]).length > 0) found.add(m[1]);
  }
  return [...found];
}

function structuredTargets(lines: string[]): ProposedTarget[] {
  const out: ProposedTarget[] = [];
  let mode: 'file' | 'symbol' | null = null;
  let action: ProposedTarget['action'] = 'unknown';
  lines.forEach((raw, i) => {
    if (HEADER.test(raw)) {
      const fileM = raw.match(FILE_HEADER);
      const symM = raw.match(SYMBOL_HEADER);
      if (fileM) { mode = 'file'; action = inferAction(fileM[1]); }
      else if (symM) { mode = 'symbol'; action = inferAction(symM[1]); }
      else { mode = null; }
      return;
    }
    if (mode === null) return;
    const item = raw.match(LIST_ITEM);
    if (!item) return;
    if (mode === 'file') {
      const file = firstFilePath(item[1]);
      if (file) out.push({ kind: 'file', value: file, action, line: i + 1, confidence: 'high' });
    } else {
      const sym = firstSymbol(item[1]);
      if (sym) out.push({ kind: 'symbol', value: sym, action, line: i + 1, confidence: 'high' });
    }
  });
  return out;
}

function heuristicTargets(lines: string[]): ProposedTarget[] {
  const out: ProposedTarget[] = [];
  lines.forEach((raw, i) => {
    const action = inferAction(raw);
    for (const m of raw.matchAll(FILE_PATH)) {
      out.push({ kind: 'file', value: m[0], action, line: i + 1, confidence: 'low' });
    }
    for (const sym of heuristicSymbols(raw)) {
      out.push({ kind: 'symbol', value: sym, action, line: i + 1, confidence: 'low' });
    }
  });
  return out;
}

export function parsePlan(text: string): ProposedTarget[] {
  const lines = text.split(/\r?\n/);
  const byKey = new Map<string, ProposedTarget>();
  // structured first so high-confidence entries win dedup
  for (const t of [...structuredTargets(lines), ...heuristicTargets(lines)]) {
    const key = `${t.kind}:${t.value}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, t); continue; }
    if (existing.confidence === 'low' && t.confidence === 'high') byKey.set(key, t);
  }
  return [...byKey.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-plan-parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate/plan-parse.ts test/validate-plan-parse.test.ts
git commit -m "feat(validate): hybrid plan parser to ProposedTarget[]"
```

---

## Task 6: Plan checks registry — `src/validate/plan-checks.ts`

**Files:**
- Create: `src/validate/plan-checks.ts`
- Test: `test/validate-plan-checks.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/validate-plan-checks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import { ConfigSchema, DEFAULT_CONFIG } from '../src/config/schema.js';
import { runPlanChecks } from '../src/validate/plan-checks.js';
import type { ProposedTarget } from '../src/validate/plan-parse.js';
import type { ExtractedSymbol } from '../src/types.js';

const sym = (name: string, signature: string, startLine = 1): ExtractedSymbol =>
  ({ kind: 'class', name, signature, exported: true, startLine, jsdoc: '' });

function seedRefund(): IndexDb {
  const db = new IndexDb(':memory:');
  db.migrate();
  const id = db.upsertFile({ path: 'src/payments/refund.service.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0 });
  db.insertSymbol(id, sym('RefundService', 'class RefundService', 2), 'src/payments/refund.service.ts');
  return db;
}

const target = (over: Partial<ProposedTarget>): ProposedTarget =>
  ({ kind: 'symbol', value: 'X', action: 'create', line: 1, confidence: 'high', ...over });

describe('reuse-candidate check', () => {
  it('flags a create symbol that contains an existing multi-token symbol', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'PartialRefundService', line: 5 })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    const f = out.find((x) => x.kind === 'reuse-candidate');
    expect(f?.file).toBe('PartialRefundService');
    expect(f?.line).toBe(5);
    expect(f?.related?.path).toBe('src/payments/refund.service.ts');
    db.close();
  });

  it('does not flag a modify-action symbol', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'PartialRefundService', action: 'modify' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });

  it('does not flag an unrelated create symbol', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'InvoiceMailer' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });

  it('flags a create file whose basename contains an existing file basename', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/payments/refund-v2.service.ts' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    const f = out.find((x) => x.kind === 'reuse-candidate');
    expect(f?.related?.path).toBe('src/payments/refund.service.ts');
    db.close();
  });

  it('suppresses a target that tokenizes to nothing', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'x' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });
});

describe('dangerous-target check', () => {
  it('flags a proposed NEW file under a dangerous.paths glob even when not indexed', () => {
    const db = seedRefund();
    const config = ConfigSchema.parse({ dangerous: { paths: ['src/auth/**'] } });
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/auth/oauth.ts', line: 9 })], db, config, severity: 'warn' });
    const f = out.find((x) => x.kind === 'dangerous-target');
    expect(f?.file).toBe('src/auth/oauth.ts');
    expect(f?.line).toBe(9);
    db.close();
  });

  it('flags a proposed entrypoint file via the index map', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile({ path: 'src/index.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/index.ts' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'dangerous-target')?.file).toBe('src/index.ts');
    db.close();
  });

  it('does not flag an ordinary proposed file', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/util/x.ts' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'dangerous-target')).toBeUndefined();
    db.close();
  });
});

describe('registry gating', () => {
  it('skips reuse when checkDuplicates is false', () => {
    const db = seedRefund();
    const config = ConfigSchema.parse({ validate: { checkDuplicates: false } });
    const out = runPlanChecks({ targets: [target({ value: 'PartialRefundService' })], db, config, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-plan-checks.test.ts`
Expected: FAIL — module `../src/validate/plan-checks.js` not found.

- [ ] **Step 3: Implement** — create `src/validate/plan-checks.ts`:

```ts
import type { IndexDb } from '../indexer/db.js';
import type { SenseiConfig } from '../config/schema.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { findDangerousFiles } from '../scorer/score.js';
import { nameContainment } from './similarity.js';
import { firstDangerousMatch } from './glob.js';
import type { Finding, FindingKind, Severity } from './report.js';
import type { ProposedTarget } from './plan-parse.js';

export interface PlanCheckContext {
  targets: ProposedTarget[];
  db: IndexDb;
  config: SenseiConfig;
  severity: Severity;
}

export interface PlanCheck {
  kind: FindingKind;
  enabled(config: SenseiConfig): boolean;
  run(ctx: PlanCheckContext): Finding[];
}

function baseNoExt(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.(?:ts|tsx|js|jsx)$/, '');
}

const reuseCandidateCheck: PlanCheck = {
  kind: 'reuse-candidate',
  enabled: (config) => config.validate.checkDuplicates,
  run({ targets, db, config, severity }) {
    const threshold = config.validate.duplicateThreshold;
    const proposedFiles = new Set(targets.filter((t) => t.kind === 'file').map((t) => t.value));
    const out: Finding[] = [];
    for (const t of targets) {
      if (t.action === 'modify') continue;
      if (tokenize(t.value).length === 0) continue;
      if (t.kind === 'symbol') {
        const best = searchSymbols(db, tokenize(t.value))
          .filter((h) => !proposedFiles.has(h.path))
          .map((h) => ({ path: h.path, line: h.start_line, name: h.name, score: nameContainment(t.value, h.name) }))
          .filter((r) => r.score >= threshold)
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))[0];
        if (best) {
          out.push({
            kind: 'reuse-candidate', severity, file: t.value, line: t.line,
            message: `plan proposes ${t.value}; existing ${best.name} at ${best.path}:${best.line} already covers this (match ${best.score.toFixed(2)}) — extend it instead of creating new.`,
            related: best,
          });
        }
      } else {
        const planBase = baseNoExt(t.value);
        const best = db.allFiles()
          .filter((f) => f.path !== t.value)
          .map((f) => ({ path: f.path, line: 1, name: baseNoExt(f.path), score: nameContainment(planBase, baseNoExt(f.path)) }))
          .filter((r) => r.score >= threshold)
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
        if (best) {
          out.push({
            kind: 'reuse-candidate', severity, file: t.value, line: t.line,
            message: `plan proposes new file ${t.value}; existing ${best.path} looks equivalent (match ${best.score.toFixed(2)}) — extend it instead.`,
            related: best,
          });
        }
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  },
};

const dangerousTargetCheck: PlanCheck = {
  kind: 'dangerous-target',
  enabled: (config) => config.validate.checkDangerous,
  run({ targets, db, config, severity }) {
    const danger = new Map(findDangerousFiles(db, config).map((d) => [d.path, d]));
    const globs = config.dangerous.paths;
    const out: Finding[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      if (t.kind !== 'file' || seen.has(t.value)) continue;
      const glob = firstDangerousMatch(t.value, globs);
      if (glob) {
        seen.add(t.value);
        out.push({ kind: 'dangerous-target', severity, file: t.value, line: t.line, message: `plan targets ${t.value} — matches dangerous path \`${glob}\`; do not modify casually.` });
        continue;
      }
      const d = danger.get(t.value);
      if (d) {
        seen.add(t.value);
        out.push({ kind: 'dangerous-target', severity, file: t.value, line: t.line, message: `plan targets ${t.value} — ${d.reason} (importer_count ${d.importerCount}); do not modify casually.` });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  },
};

export const PLAN_CHECKS: PlanCheck[] = [reuseCandidateCheck, dangerousTargetCheck];

export function runPlanChecks(ctx: PlanCheckContext): Finding[] {
  return PLAN_CHECKS.filter((c) => c.enabled(ctx.config)).flatMap((c) => c.run(ctx));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-plan-checks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate/plan-checks.ts test/validate-plan-checks.test.ts
git commit -m "feat(validate): plan-checks registry (reuse + dangerous-target)"
```

---

## Task 7: Orchestrator — `src/core/run-validate-plan.ts`

**Files:**
- Create: `src/core/run-validate-plan.ts`
- Test: covered by the E2E in Task 9 (this task adds a focused unit test for the no-index error and the blocked flag)
- Test: `test/validate-plan-run.test.ts`

- [ ] **Step 1: Write the failing test** — create `test/validate-plan-run.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexDb } from '../src/indexer/db.js';
import { runInit } from '../src/core/run-init.js';
import { runValidatePlan } from '../src/core/run-validate-plan.js';
import type { ExtractedSymbol } from '../src/types.js';
import { dbPath } from '../src/paths.js';

const sym = (name: string, signature: string, startLine = 1): ExtractedSymbol =>
  ({ kind: 'class', name, signature, exported: true, startLine, jsdoc: '' });

let work: string | undefined;
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); work = undefined; });

function seed(dir: string): void {
  runInit(dir);
  const db = new IndexDb(dbPath(dir));
  db.migrate();
  const id = db.upsertFile({ path: 'src/payments/refund.service.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0 });
  db.insertSymbol(id, sym('RefundService', 'class RefundService', 2), 'src/payments/refund.service.ts');
  db.close();
}

describe('runValidatePlan', () => {
  it('throws a clear error when no index exists', async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-plan-noidx-'));
    await expect(runValidatePlan(work, '## New Symbols\n- `Foo`')).rejects.toThrow(/Run `sensei scan` first/);
  });

  it('produces a reuse-candidate and sets blocked under block', async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-plan-run-'));
    seed(work);
    const text = '## New Symbols\n- `PartialRefundService`';
    const warn = await runValidatePlan(work, text);
    expect(warn.findings.some((f) => f.kind === 'reuse-candidate')).toBe(true);
    expect(warn.blocked).toBe(false);
    const blocked = await runValidatePlan(work, text, { block: true });
    expect(blocked.blocked).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validate-plan-run.test.ts`
Expected: FAIL — module `../src/core/run-validate-plan.js` not found.

- [ ] **Step 3: Implement** — create `src/core/run-validate-plan.ts` (mirrors `run-validate-diff.ts` structure):

```ts
import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import { dbPath } from '../paths.js';
import { parsePlan } from '../validate/plan-parse.js';
import { runPlanChecks } from '../validate/plan-checks.js';
import { writePlanValidation, type Finding, type ValidationReport } from '../validate/report.js';

export interface ValidatePlanOptions {
  block?: boolean;
}

export async function runValidatePlan(
  cwd: string,
  planText: string,
  opts: ValidatePlanOptions = {},
  now: Date = new Date(),
): Promise<ValidationReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const blocking = opts.block ?? config.validate.block;
  const severity: Finding['severity'] = blocking ? 'block' : 'warn';
  const targets = parsePlan(planText);

  const db = new IndexDb(dbPath(cwd));
  try {
    const findings = runPlanChecks({ targets, db, config, severity });
    const report: ValidationReport = {
      source: 'plan',
      generatedAt: now.toISOString(),
      findings,
      blocked: blocking && findings.length > 0,
    };
    writePlanValidation(cwd, report);
    return report;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/validate-plan-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/run-validate-plan.ts test/validate-plan-run.test.ts
git commit -m "feat(core): run-validate-plan orchestrator"
```

---

## Task 8: Command — `src/commands/validate-plan.ts`

**Files:**
- Create: `src/commands/validate-plan.ts`
- Verify: build compiles and the command is registered.

- [ ] **Step 1: Implement** — create `src/commands/validate-plan.ts` (mirrors `validate-diff.ts`; reads a positional plan file or stdin):

```ts
import fs from 'node:fs';
import { Args, Command, Flags } from '@oclif/core';
import { runValidatePlan } from '../core/run-validate-plan.js';
import { renderValidation, type ValidationReport } from '../validate/report.js';
import { lastPlanValidationJsonPath } from '../paths.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export default class ValidatePlan extends Command {
  static description = 'Check an agent plan against the index for reuse violations and dangerous targets.';
  static examples = [
    '<%= config.bin %> validate-plan plan.md',
    'cat plan.md | <%= config.bin %> validate-plan --stdin --block',
  ];
  static args = {
    plan: Args.string({ description: 'Path to the plan markdown file.', required: false }),
  };
  static flags = {
    stdin: Flags.boolean({ description: 'Read the plan from stdin instead of a file.', default: false }),
    block: Flags.boolean({ description: 'Exit non-zero if any finding.', default: false }),
    json: Flags.boolean({ description: 'Emit the JSON report.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ValidatePlan);

    let planText: string;
    try {
      if (flags.stdin) {
        planText = await readStdin();
      } else if (args.plan) {
        planText = fs.readFileSync(args.plan, 'utf8');
      } else {
        this.error('Provide a plan file path or use --stdin.', { exit: 2 });
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    }

    let report: ValidationReport;
    try {
      report = await runValidatePlan(process.cwd(), planText, { block: flags.block || undefined });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    }

    if (flags.json) {
      this.log(JSON.stringify(report, null, 2));
    } else {
      this.log(renderValidation(report));
      this.log(`Report: ${lastPlanValidationJsonPath(process.cwd())}`);
    }
    if (report.blocked) this.exit(1);
  }
}
```

Note: the `planText`/`report` definite-assignment pattern matches `validate-diff.ts`, where `this.error(...)` (which never returns) precedes the use. If the TypeScript compiler flags `planText` as "used before assigned", add `let planText!: string;` and `let report!: ValidationReport;` (non-null assertion) to match the established pattern — confirm against how `validate-diff.ts` compiles in this repo and mirror it exactly.

- [ ] **Step 2: Build to verify the command compiles and registers**

Run: `npm run build`
Expected: SUCCESS — no type errors; `dist/commands/validate-plan.js` emitted.

- [ ] **Step 3: Smoke-test the registered command**

Run: `node bin/run.js validate-plan --help`
Expected: prints the command description, the `plan` arg, and `--stdin/--block/--json` flags.

- [ ] **Step 4: Commit**

```bash
git add src/commands/validate-plan.ts
git commit -m "feat(cli): add validate-plan command"
```

---

## Task 9: E2E + docs

**Files:**
- Test: `test/validate-plan-e2e.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the E2E test** — create `test/validate-plan-e2e.test.ts` (mirrors `validate-e2e.test.ts` setup; uses the real fixture symbol `UserProfile` in `src/user/profile.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runValidatePlan } from '../src/core/run-validate-plan.js';
import { configPath } from '../src/paths.js';

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
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-vp-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  // enable a dangerous-path glob over the auth dir
  fs.writeFileSync(configPath(work), JSON.stringify({ dangerous: { paths: ['src/auth/**'] } }, null, 2));
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('runValidatePlan (e2e on fixture)', () => {
  it('flags a reuse-candidate that duplicates an existing fixture symbol', async () => {
    const plan = [
      '## New Symbols',
      '- `UserProfileManager`',
    ].join('\n');
    const report = await runValidatePlan(work, plan, {}, FIXED);
    const reuse = report.findings.find((f) => f.kind === 'reuse-candidate');
    expect(reuse?.file).toBe('UserProfileManager');
    expect(reuse?.related?.path).toBe('src/user/profile.ts');
    expect(report.blocked).toBe(false);
  });

  it('flags a proposed NEW file under the dangerous glob (not yet indexed)', async () => {
    const plan = ['## Files to Create', '- `src/auth/oauth.ts`'].join('\n');
    const report = await runValidatePlan(work, plan, {}, FIXED);
    expect(report.findings.find((f) => f.kind === 'dangerous-target')?.file).toBe('src/auth/oauth.ts');
  });

  it('returns no findings for a clean, unrelated plan', async () => {
    const plan = ['## Files to Modify', '- `src/util/strings.ts`', '', 'Tweak helper formatting.'].join('\n');
    const report = await runValidatePlan(work, plan, {}, FIXED);
    expect(report.findings).toEqual([]);
  });

  it('sets blocked=true under block for a plan with findings', async () => {
    const plan = '## New Symbols\n- `UserProfileManager`';
    const report = await runValidatePlan(work, plan, { block: true }, FIXED);
    expect(report.blocked).toBe(true);
  });

  it('is deterministic: same plan + index → identical findings', async () => {
    const plan = '## New Symbols\n- `UserProfileManager`';
    const a = await runValidatePlan(work, plan, {}, FIXED);
    const b = await runValidatePlan(work, plan, {}, FIXED);
    expect(b.findings).toEqual(a.findings);
  });
});
```

- [ ] **Step 2: Run the E2E test**

Run: `npx vitest run test/validate-plan-e2e.test.ts`
Expected: PASS. (If the reuse case fails, confirm the fixture still defines `export class UserProfile` in `test/fixtures/sample-repo/src/user/profile.ts` — `UserProfile` tokenizes to `['user','profile']`, and `UserProfileManager` → `['user','profile','manager']` gives containment `2/2 = 1.0 ≥ 0.7`.)

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS — all prior tests plus the new validate-plan tests green.

- [ ] **Step 4: Update `README.md`.** Two edits:

(a) In the CLI/usage section (near the existing `sensei export` example around line 73), add:

```md
sensei validate-plan plan.md            # check an agent plan before it writes code
cat plan.md | sensei validate-plan --stdin --block   # fail if the plan reuses/targets dangerously
```

(b) Replace the Roadmap line (line 149) — remove `validate-plan` from the *planned* list since it now ships:

```md
Planned: a GitHub Action, embeddings-based retrieval, multi-language support, and Cursor/Codex exporters.
```

And, if the README has an enforcement/features section listing `validate-diff` and `guard`, add a sibling bullet:

```md
- `validate-plan <plan.md>` — parse an agent's plan and flag reuse violations and dangerous-path targets against the index before any code is written. Warn-only by default; `--block` to enforce.
```

- [ ] **Step 5: Commit**

```bash
git add test/validate-plan-e2e.test.ts README.md
git commit -m "test(validate): e2e for validate-plan; docs"
```

---

## Self-Review (completed during authoring)

**Spec coverage:**
- §3 command + flags (`--stdin/--block/--json`, positional plan) → Task 8.
- §4.1 hybrid parser + `ProposedTarget` → Task 5.
- §4.2 reuse-candidate (name-containment, single-token guard) + dangerous-target (glob ∪ index map) → Tasks 3, 6.
- §4.3 shared `similarity.ts` extraction + re-export → Task 3.
- §5 extended `FindingKind`, `source: 'plan'`, separate `last-plan-validation.json`, render groups → Task 4.
- §6 `dangerous.paths` config key → Task 1.
- §7 exit/severity (warn default, `--block`, exit 2 on missing index/file/bad invocation) → Tasks 7, 8.
- §8 freshness (missing index hard error) → Task 7.
- §9 module layout → Tasks 2-8 (every file accounted for).
- §10 false-positive mitigations (tokenizer suppression, containment guard, action gating, warn-only) → Tasks 5, 6.
- §12 tests (parse, checks, similarity, report, e2e) → Tasks 3-9.

**Placeholder scan:** none — every code/test step contains complete content.

**Type consistency:** `ProposedTarget` (Task 5) consumed unchanged in Tasks 6-7; `PlanCheckContext`/`runPlanChecks` signature identical across Tasks 6-7; `FindingKind` union (Task 4) matches the `kind` literals emitted in Task 6 (`reuse-candidate`, `dangerous-target`); `writePlanValidation`/`lastPlanValidationJsonPath` defined in Task 4 and used in Tasks 7-8; `nameContainment` defined in Task 3, used in Task 6.

**Dependency note:** `ignore` is already a production dependency (used by the scanner); no `package.json` change needed. Confirm with `node -e "require('ignore')"` before Task 2 if in doubt.
