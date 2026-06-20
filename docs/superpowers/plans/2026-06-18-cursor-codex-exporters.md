# Cursor/Codex Exporters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sensei export --target cursor|codex` rendering (markdown) plus a `--write` flag that injects Sensei context into each tool's native rule file without destroying user content.

**Architecture:** Two new markdown renderers consume the existing `ContextReport`. `renderCodex` produces the shared markdown body; `renderCursor` wraps it with MDC frontmatter (DRY — no separate `sections.ts`). `--write` persistence diverges by file type: Codex writes a **managed section** (marker-delimited) into the shared `AGENTS.md`, preserving surrounding user content; Cursor overwrites its **dedicated** `.cursor/rules/sensei.mdc` wholesale because MDC YAML frontmatter must be the first bytes of the file and therefore cannot live inside HTML-comment markers. `renderClaude` is untouched.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), oclif commands, zod report schema, vitest, Node `fs`. No new dependencies.

## Global Constraints

- Node `>=22`, ESM (`"type": "module"`); all relative imports use `.js` extensions.
- **No new dependencies** in this phase.
- Managed-section markers, exact: `<!-- SENSEI:START -->` and `<!-- SENSEI:END -->`.
- Native paths: cursor → `.cursor/rules/sensei.mdc`; codex → `AGENTS.md` (both repo-root relative).
- `renderClaude` output must not change (existing test in `test/exporter.test.ts` must keep passing).
- `--write` is **not** supported for `--target claude` → throw, directing user to stdout.
- Tests run with `npx vitest run <file>`; single test with `-t "<name>"`.
- Conventional Commits for messages.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/exporters/codex.ts` | **new** — `renderCodex(report)`: shared markdown body (3 sections). |
| `src/exporters/cursor.ts` | **new** — `renderCursor(report)`: MDC frontmatter + `renderCodex` body. |
| `src/exporters/write-section.ts` | **new** — `writeManagedSection(filePath, body)` + marker constants. |
| `src/paths.ts` | **modify** — add `cursorRulePath`, `codexRulePath`. |
| `src/core/run-export.ts` | **modify** — dispatch cursor/codex, `ExportOptions.write` handling. |
| `src/commands/export.ts` | **modify** — add `--write`/`-w` boolean flag. |
| `test/exporter.test.ts` | **modify** — extend with renderer, `writeManagedSection`, and `runExport --write` tests. |

---

## Task 1: Markdown renderers (`renderCodex`, `renderCursor`)

**Files:**
- Create: `src/exporters/codex.ts`
- Create: `src/exporters/cursor.ts`
- Test: `test/exporter.test.ts` (extend)

**Interfaces:**
- Consumes: `ContextReport` from `src/types.ts` (`{ task, generatedAt, reuseCandidates[], dangerousFiles[], agentRules[] }`).
- Produces:
  - `renderCodex(report: ContextReport): string` — markdown body, no frontmatter.
  - `renderCursor(report: ContextReport): string` — `renderCodex` body prefixed with MDC frontmatter.

- [ ] **Step 1: Write the failing tests**

Add to the top imports of `test/exporter.test.ts`:

```typescript
import { renderCodex } from '../src/exporters/codex.js';
import { renderCursor } from '../src/exporters/cursor.js';
```

Append these describe blocks to `test/exporter.test.ts`:

```typescript
const emptyReport: ContextReport = {
  task: 'small tweak',
  generatedAt: '2026-06-16T00:00:00.000Z',
  reuseCandidates: [],
  dangerousFiles: [],
  agentRules: ['Prefer reuse'],
};

describe('renderCodex', () => {
  it('renders markdown body with candidates and dangerous files', () => {
    expect(renderCodex(report)).toBe(
      [
        '# Sensei context for: add password reset',
        '',
        '## Reuse these (do not reimplement)',
        '- `src/auth/login.ts:2` login — login(email, password): boolean',
        '',
        '## Do not touch without confirmation (high-impact files)',
        '- `src/auth/login.ts` (3 files import this)',
        '',
        '## Rules',
        '- Reuse existing code',
      ].join('\n'),
    );
  });

  it('renders empty-state placeholders when there are no candidates', () => {
    expect(renderCodex(emptyReport)).toBe(
      [
        '# Sensei context for: small tweak',
        '',
        '## Reuse these (do not reimplement)',
        '- (no strong matches found)',
        '',
        '## Do not touch without confirmation (high-impact files)',
        '- (none detected)',
        '',
        '## Rules',
        '- Prefer reuse',
      ].join('\n'),
    );
  });
});

describe('renderCursor', () => {
  it('prefixes MDC frontmatter then the shared markdown body', () => {
    const out = renderCursor(report);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('alwaysApply: true');
    expect(out).toContain(renderCodex(report));
    // frontmatter must precede the body so Cursor can parse it
    expect(out.indexOf('alwaysApply: true')).toBeLessThan(out.indexOf('## Reuse these'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/exporter.test.ts -t "renderCodex"`
Expected: FAIL — cannot resolve `../src/exporters/codex.js`.

- [ ] **Step 3: Implement `renderCodex`**

Create `src/exporters/codex.ts`:

```typescript
import type { ContextReport } from '../types.js';

/** Markdown body shared by the Codex (AGENTS.md) and Cursor (.mdc) exporters. */
export function renderCodex(report: ContextReport): string {
  const lines: string[] = [];
  lines.push(`# Sensei context for: ${report.task}`);
  lines.push('');
  lines.push('## Reuse these (do not reimplement)');
  if (report.reuseCandidates.length === 0) {
    lines.push('- (no strong matches found)');
  } else {
    for (const c of report.reuseCandidates) {
      lines.push(`- \`${c.path}:${c.line}\` ${c.name} — ${c.signature}`);
    }
  }
  lines.push('');
  lines.push('## Do not touch without confirmation (high-impact files)');
  if (report.dangerousFiles.length === 0) {
    lines.push('- (none detected)');
  } else {
    for (const d of report.dangerousFiles) {
      lines.push(`- \`${d.path}\` (${d.reason})`);
    }
  }
  lines.push('');
  lines.push('## Rules');
  for (const r of report.agentRules) lines.push(`- ${r}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Implement `renderCursor`**

Create `src/exporters/cursor.ts`:

```typescript
import type { ContextReport } from '../types.js';
import { renderCodex } from './codex.js';

const FRONTMATTER = [
  '---',
  'description: Sensei reuse/danger context for the current task',
  'globs: "**/*"',
  'alwaysApply: true',
  '---',
].join('\n');

/** Cursor MDC: YAML frontmatter (must be file-top) then the shared markdown body. */
export function renderCursor(report: ContextReport): string {
  return `${FRONTMATTER}\n${renderCodex(report)}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/exporter.test.ts`
Expected: PASS (existing `renderClaude` test + 3 new tests).

- [ ] **Step 6: Commit**

```bash
git add src/exporters/codex.ts src/exporters/cursor.ts test/exporter.test.ts
git commit -m "feat: cursor/codex markdown exporters"
```

---

## Task 2: Managed-section writer (`writeManagedSection`)

**Files:**
- Create: `src/exporters/write-section.ts`
- Test: `test/exporter.test.ts` (extend)

**Interfaces:**
- Produces:
  - `SECTION_START: string` = `'<!-- SENSEI:START -->'`
  - `SECTION_END: string` = `'<!-- SENSEI:END -->'`
  - `writeManagedSection(filePath: string, body: string): void`

- [ ] **Step 1: Write the failing tests**

Add to the imports of `test/exporter.test.ts`:

```typescript
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { writeManagedSection, SECTION_START, SECTION_END } from '../src/exporters/write-section.js';
```

Append this describe block to `test/exporter.test.ts`:

```typescript
describe('writeManagedSection', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ws-'));
  });

  it('creates the file (and parent dirs) when absent', () => {
    const file = path.join(dir, 'nested', 'deep', 'AGENTS.md');
    writeManagedSection(file, 'BODY');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${SECTION_START}\nBODY\n${SECTION_END}\n`);
  });

  it('replaces the block in place and preserves surrounding content', () => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `top\n${SECTION_START}\nOLD\n${SECTION_END}\nbottom\n`);
    writeManagedSection(file, 'NEW');
    expect(fs.readFileSync(file, 'utf8')).toBe(`top\n${SECTION_START}\nNEW\n${SECTION_END}\nbottom\n`);
  });

  it('is idempotent across re-runs with the same body', () => {
    const file = path.join(dir, 'AGENTS.md');
    writeManagedSection(file, 'BODY');
    const first = fs.readFileSync(file, 'utf8');
    writeManagedSection(file, 'BODY');
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('appends a block with one blank-line separator when no markers exist', () => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, 'user content\n');
    writeManagedSection(file, 'BODY');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `user content\n\n${SECTION_START}\nBODY\n${SECTION_END}\n`,
    );
  });
});
```

Add `beforeEach` to the vitest import at the top of the file (currently `import { describe, it, expect } from 'vitest';`):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/exporter.test.ts -t "writeManagedSection"`
Expected: FAIL — cannot resolve `../src/exporters/write-section.js`.

- [ ] **Step 3: Implement `writeManagedSection`**

Create `src/exporters/write-section.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';

export const SECTION_START = '<!-- SENSEI:START -->';
export const SECTION_END = '<!-- SENSEI:END -->';

/**
 * Inject `body` into `filePath` between managed markers, preserving any
 * surrounding user content. Idempotent: re-running replaces the same block.
 */
export function writeManagedSection(filePath: string, body: string): void {
  const block = `${SECTION_START}\n${body}\n${SECTION_END}`;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${block}\n`);
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const markers = new RegExp(`${escapeRe(SECTION_START)}[\\s\\S]*?${escapeRe(SECTION_END)}`);
  if (markers.test(existing)) {
    // function replacement avoids `$` in body being treated as a back-reference
    fs.writeFileSync(filePath, existing.replace(markers, () => block));
    return;
  }

  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, `${existing}${sep}${block}\n`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/exporter.test.ts -t "writeManagedSection"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exporters/write-section.ts test/exporter.test.ts
git commit -m "feat: managed-section writer for native rule files"
```

---

## Task 3: Wire dispatch + `--write` (paths, run-export, command)

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/core/run-export.ts:9-19`
- Modify: `src/commands/export.ts:6-13`
- Test: `test/exporter.test.ts` (extend)

**Interfaces:**
- Consumes: `renderCursor`, `renderCodex` (Task 1), `writeManagedSection` (Task 2).
- Produces:
  - `cursorRulePath(cwd: string): string` → `<cwd>/.cursor/rules/sensei.mdc`
  - `codexRulePath(cwd: string): string` → `<cwd>/AGENTS.md`
  - `runExport(cwd: string, target: string, opts?: { write?: boolean }): string`

- [ ] **Step 1: Write the failing integration tests**

Add to the imports of `test/exporter.test.ts`:

```typescript
import { runExport } from '../src/core/run-export.js';
import { candidatesJsonPath, cursorRulePath, codexRulePath } from '../src/paths.js';
```

Append this describe block to `test/exporter.test.ts` (reuses `report` and the `dir` set up in `beforeEach`):

```typescript
describe('runExport --write', () => {
  function seed(cwd: string) {
    const dest = candidatesJsonPath(cwd);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(report));
  }

  it('writes a whole dedicated MDC file for cursor', () => {
    seed(dir);
    const msg = runExport(dir, 'cursor', { write: true });
    const written = fs.readFileSync(cursorRulePath(dir), 'utf8');
    expect(msg).toContain('.cursor/rules/sensei.mdc');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toContain('- `src/auth/login.ts:2` login — login(email, password): boolean');
  });

  it('writes a managed section into AGENTS.md for codex, preserving user content', () => {
    seed(dir);
    fs.writeFileSync(codexRulePath(dir), '# My project\n');
    runExport(dir, 'codex', { write: true });
    const written = fs.readFileSync(codexRulePath(dir), 'utf8');
    expect(written.startsWith('# My project\n')).toBe(true);
    expect(written).toContain(SECTION_START);
    expect(written).toContain('## Reuse these (do not reimplement)');
  });

  it('refuses --write for claude', () => {
    seed(dir);
    expect(() => runExport(dir, 'claude', { write: true })).toThrow(/not supported/);
  });

  it('without --write, cursor/codex return to stdout and touch no disk', () => {
    seed(dir);
    expect(runExport(dir, 'codex')).toBe(renderCodex(report));
    expect(fs.existsSync(codexRulePath(dir))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/exporter.test.ts -t "runExport --write"`
Expected: FAIL — `runExport` currently throws `"...not implemented yet (Phase 2)"` for cursor/codex and ignores a third arg; `cursorRulePath`/`codexRulePath` are not exported.

- [ ] **Step 3: Add native path helpers**

Append to `src/paths.ts`:

```typescript
export const cursorRulePath = (cwd: string) => path.join(cwd, '.cursor', 'rules', 'sensei.mdc');
export const codexRulePath = (cwd: string) => path.join(cwd, 'AGENTS.md');
```

- [ ] **Step 4: Rewrite `runExport` dispatch**

Replace the entire body of `src/core/run-export.ts` with:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { candidatesJsonPath, cursorRulePath, codexRulePath } from '../paths.js';
import { ContextReportSchema } from '../report/schema.js';
import { renderClaude } from '../exporters/claude.js';
import { renderCursor } from '../exporters/cursor.js';
import { renderCodex } from '../exporters/codex.js';
import { writeManagedSection } from '../exporters/write-section.js';

const TARGETS = ['claude', 'cursor', 'codex'] as const;
export type ExportTarget = (typeof TARGETS)[number];

export interface ExportOptions {
  write?: boolean;
}

export function runExport(cwd: string, target: string, opts: ExportOptions = {}): string {
  if (!fs.existsSync(candidatesJsonPath(cwd))) {
    throw new Error('No context report found. Run `sensei context "<task>"` first.');
  }
  const report = ContextReportSchema.parse(
    JSON.parse(fs.readFileSync(candidatesJsonPath(cwd), 'utf8')),
  );

  if (target === 'claude') {
    if (opts.write) {
      throw new Error(
        '--write is not supported for target "claude" (no canonical native file). Redirect stdout into your rules file instead.',
      );
    }
    return renderClaude(report);
  }

  if (target === 'cursor') {
    const out = renderCursor(report);
    if (!opts.write) return out;
    // dedicated, sensei-owned file: whole-file write keeps MDC frontmatter at the top
    const dest = cursorRulePath(cwd);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${out}\n`);
    return `Wrote Sensei context to ${path.relative(cwd, dest)}`;
  }

  if (target === 'codex') {
    const out = renderCodex(report);
    if (!opts.write) return out;
    // shared file: preserve user content via managed section
    const dest = codexRulePath(cwd);
    writeManagedSection(dest, out);
    return `Wrote Sensei context to ${path.relative(cwd, dest)}`;
  }

  throw new Error(`Unknown export target "${target}". Supported: ${TARGETS.join(', ')}.`);
}
```

- [ ] **Step 5: Add the `--write` flag to the command**

Replace `src/commands/export.ts` with:

```typescript
import { Command, Flags } from '@oclif/core';
import { runExport } from '../core/run-export.js';

export default class Export extends Command {
  static description = 'Export the latest context report for an AI agent.';
  static flags = {
    target: Flags.string({ char: 't', description: 'Export target', options: ['claude', 'cursor', 'codex'], default: 'claude' }),
    write: Flags.boolean({ char: 'w', description: "Write into the target's native rule file (cursor/codex only)", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Export);
    this.log(runExport(process.cwd(), flags.target, { write: flags.write }));
  }
}
```

- [ ] **Step 6: Run the full exporter suite**

Run: `npx vitest run test/exporter.test.ts`
Expected: PASS (all renderer, writeManagedSection, and runExport --write tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/paths.ts src/core/run-export.ts src/commands/export.ts test/exporter.test.ts
git commit -m "feat: wire --write to native cursor/codex rule files"
```

---

## Self-Review

**Spec coverage (§3 of the design):**
- §3.1 files — codex.ts, cursor.ts, write-section.ts created; run-export.ts, export.ts, exporter.test.ts modified. Deviations: `sections.ts` dropped (cursor wraps codex — DRY, fewer files); `paths.ts` added for native paths (was implicit in spec). ✓
- §3.2 renderers — markdown body, cursor frontmatter, no `renderClaude` change. ✓
- §3.3 `--write` — managed-section for codex; create-when-absent, replace-in-place, append-when-no-markers, idempotent all tested; claude+`--write` errors; no-`--write` is stdout-only. **Deviation:** cursor uses whole-file write of its dedicated `.mdc` instead of a managed section, because MDC frontmatter must be the first bytes of the file and cannot sit inside HTML-comment markers. User content safety is preserved (the file is sensei-owned; user rules live in other `.cursor/rules/*.mdc` files). Flag for user review.
- §3.4 tests — renderer snapshots (with/without candidates) via exact `toBe`; writeManagedSection five behaviors covered. ✓

**Placeholder scan:** none — every step has complete code/commands. ✓

**Type consistency:** `renderCodex`/`renderCursor`/`writeManagedSection`/`SECTION_START`/`SECTION_END`/`cursorRulePath`/`codexRulePath`/`ExportOptions` names identical across definition and use sites. ✓

---

## Open Decision For User

The spec said managed section for **both** targets. This plan writes Cursor's dedicated `.mdc` whole-file (frontmatter constraint) and reserves managed sections for Codex's shared `AGENTS.md`. If you'd rather keep markers in the `.mdc` too, the fallback is: frontmatter unmanaged at file top + managed block below — costs a `preamble` param on `writeManagedSection`. Say so and I'll adjust Task 3.
