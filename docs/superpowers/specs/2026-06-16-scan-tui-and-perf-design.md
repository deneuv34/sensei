# Scan TUI + Performance Design

Date: 2026-06-16
Status: Approved (pending implementation)

## Problem

`sensei scan` appears to hang on large projects. Two independent root causes:

1. **Genuinely slow.** `scanRepo` (`src/scanner/scan.ts:57`) runs `git.log({ file: rel })`
   once per file. A repo with N source files spawns N sequential git subprocesses.
   On a few-thousand-file repo this is minutes of real wall-time.
2. **No feedback.** `runScan` (`src/core/run-scan.ts`) runs silently; `commands/scan.ts`
   prints a single summary line only after everything finishes. Even a fast scan looks frozen.

## Goals

- Cut scan wall-time dramatically (target: collapse per-file git spawns to a single pass;
  replace heavyweight AST parsing with a lighter parser).
- Give a live, "sophisticated" terminal UI so the user always sees forward motion.
- Keep the core (scanner/indexer) headless and pure — no UI dependency leaks into core.
- Preserve all existing behavior: warnings, final summary, untracked-file defaults, CI output.

## Non-Goals (YAGNI)

- No parallel worker pool for parsing.
- No incremental / cached git-metadata between runs.
- No `ink` React dashboard.
- No progress UI for `validate-diff` / `guard` (scan only this round).

## Approach

Scope chosen: **UI + performance** together. They share the same progress-event plumbing.

### A. Performance

#### A1. Batch git metadata (single pass)

Remove the per-file `git.log` loop from `src/scanner/scan.ts`. Add a new module
`src/scanner/git-meta.ts` whose sole job is to run one git command and parse it into a map.

Command:

```
git log --name-only --format=__C__%ct
```

- `__C__` is a record marker prefixing each commit header line.
- `%ct` = committer unix timestamp. (The commit hash was unused downstream, so it is
  not emitted — the marker alone disambiguates header lines from file lines.)
- Lines after a header until the next marker / blank are the files touched by that commit.

Parse stdout once into:

```ts
Map<string /* posix relPath */, { lastModified: number; commitCount: number }>
```

- `lastModified` = timestamp of the most recent commit touching the path (first occurrence,
  since `git log` is newest-first).
- `commitCount` = number of commits touching the path.

`scanRepo` calls `git-meta` once (after detecting it is a repo), then the file loop looks up
the map instead of spawning git. Untracked file → map miss → existing defaults
(`gitLastModified: null`, `gitCommitCount: 0`).

Run via `simple-git`'s `git.raw([...])` (already a dependency) or `child_process.execFile`
a single time. `git-meta` is a pure function over the raw stdout string, so it is unit-testable
with a fixture.

Net: N subprocess spawns → 1.

#### A2. Replace ts-morph with raw TypeScript parser

`src/ast/extract.ts` currently builds a full ts-morph `Project` per file — this constructs a
program/type-checker we never use (symbol extraction needs no types).

Rewrite `extractFromSource` to use `ts.createSourceFile` (no type-checker) and walk the tree
with `ts.forEachChild`. Extraction rules stay identical to today:

- **function** declarations with a name → `name(params): ret`, exported flag, start line, jsdoc.
- **class** declarations → `class Name`; plus each **method** as `Name.method` with signature.
- **interface**, **type** alias, **enum** declarations.
- **top-level** `const`/variable declarations only (skip nested).
- **imports**: default → `default`, namespace → `*`, named → each name, side-effect → `''`.

Implementation notes:

- Signature text (params, return type) via `node.parameters`/`node.type` mapped through
  `n.getText(sourceFile)`.
- Exported flag via `ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export`
  (and `Default`), or presence on the modifiers array.
- Start line via `sourceFile.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1`.
- JSDoc via `ts.getJSDocCommentsAndTags(node)` → comment text joined/trimmed.

Add `typescript` as a direct dependency; remove `ts-morph`.

This is the riskier change. The existing `extract` test suite is the regression guard and must
stay green; add cases for any uncovered shapes (arrow-fn const, default export, side-effect import).

### B. Progress plumbing

Core stays pure: progress is emitted through an injected callback, never a UI import.

```ts
// src/core/progress.ts
export type ScanPhase = 'discover' | 'gitmeta' | 'parse' | 'resolve';

export interface ScanProgress {
  phase: ScanPhase;
  done: number;     // items processed so far
  total: number;    // total items; 0 = indeterminate
  detail?: string;  // e.g. current file path
}

export type ProgressFn = (p: ScanProgress) => void;

export const noopProgress: ProgressFn = () => {};
```

Threading:

- `runScan(cwd, onProgress = noopProgress)` passes `onProgress` to scanner + indexer.
- `scanRepo(cwd, config, onProgress = noopProgress)`:
  - emits `discover` (indeterminate) during glob + gitignore filter,
  - emits `gitmeta` (single tick) after the batched git pass,
  - emits `discover` per-file ticks (`done/total`, detail = path) during read + hash
    of each kept file (fast I/O loop; no git spawn).
- `indexFiles(db, cwd, files, onProgress = noopProgress)`:
  - emits `parse` ticks per changed file (`done/total`, detail = path),
  - emits `resolve` while linking the import graph.

Default `noopProgress` keeps all existing callers and tests unchanged; core remains headless.

### C. Terminal UI (listr2)

`src/commands/scan.ts` owns `listr2` and translates `ScanProgress` events into task updates.
Four tasks map 1:1 to the four phases.

TTY (live):

```
  sensei scan

  ✔ Discover files        1,842 found
  ✔ Git history           1 pass · 1,842 files mapped
  ⠋ Parse & index         1,203/1,842  src/api/routes/user.ts
    Resolve imports       pending

  314 changed · 18,902 symbols so far
```

Done:

```
  sensei scan  ✓ 2.4s

  ✔ Discover files        1,842 found
  ✔ Git history           1,842 files mapped
  ✔ Parse & index         314 changed · 21,407 symbols
  ✔ Resolve imports       graph linked

  Next: sensei context "<your task>"
  ⚠ 2 warnings (sensei scan --verbose to see)
```

Non-TTY / CI (listr2 auto-fallback renderer):

```
[discover] 1842 files
[gitmeta] mapped 1842
[parse] 314 changed, 21407 symbols
[resolve] done
Scanned 1842 files (314 changed), indexed 21407 symbols.
```

Mapping rules:

- The `parse` task drives `task.output` with the live `done/total path` line, bumped on each tick.
- Warnings collapse to a count in the footer; a new `--verbose` flag lists them in full
  (preserves the current per-warning output, now opt-in).
- Footer (changed / symbol counts / next-step) prints after the task list, matching the
  current final `log` in `commands/scan.ts`.

### D. Errors

- `git-meta`: git binary missing or not a repo → return empty map, no throw
  (preserves today's behavior). Boundary-level catch, not per-file.
- Parser throw on a single file → push warning + skip. The `parse` task still completes;
  warning shows in the footer count. Note: `ts.createSourceFile` is error-tolerant and does
  not throw on malformed syntax (unlike the old ts-morph path), so this catch now fires only
  on truly exceptional errors — a robustness improvement, not a regression.
- A listr2 task rejects only on a fatal error (e.g. db open failure). Otherwise the scan
  always runs to completion.

## File changes

| File | Change |
|------|--------|
| `src/scanner/git-meta.ts` | NEW — run + parse single git log into a path→meta map. |
| `src/scanner/scan.ts` | Drop per-file `git.log`; call `git-meta` once; emit progress. |
| `src/ast/extract.ts` | Rewrite on raw `typescript` (`ts.createSourceFile`), drop ts-morph. |
| `src/core/progress.ts` | NEW — `ScanPhase`, `ScanProgress`, `ProgressFn`, `noopProgress`. |
| `src/core/run-scan.ts` | Thread optional `onProgress` to scanner + indexer. |
| `src/indexer/index-repo.ts` | Emit `parse`/`resolve` progress ticks. |
| `src/commands/scan.ts` | listr2 task list; map progress → tasks; `--verbose` flag; footer. |
| `package.json` | `+ listr2`, `+ typescript` (direct), `− ts-morph`. |

## Testing

- `git-meta.test.ts` — parse fixture stdout → map. Edges: untracked file absent,
  multi-commit count, empty-repo (empty string) → empty map.
- `extract.test.ts` (existing) — stays green across the ts-morph→typescript swap;
  add cases for arrow-fn const, default export, side-effect import if uncovered.
- `progress.test.ts` — run `runScan` with a recording `onProgress`; assert phase order
  (`discover` → `gitmeta` → `parse` → `resolve`) and monotonically non-decreasing `done`.
- No TUI snapshot tests (brittle). The listr2 layer stays thin; logic lives in core where it
  is already tested.
