# Sensei — `validate-diff` + `guard` Design (Enforcement, Phase 2.1)

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Builds on:** `docs/superpowers/specs/2026-06-16-sensei-design.md` (MVP). Assumes the MVP index, config, scanner, AST, search, scorer, and report modules exist and are committed.

---

## 1. Summary

The MVP delivers the *advisory* half of Sensei's wedge: before an agent writes code, `context "<task>"` says what exists, what to reuse, and what not to touch. Nothing yet checks whether the agent (or human) listened.

This cycle adds the *enforcement* half:

> **After code is written, Sensei checks the diff: did it re-implement something that already exists, and did it edit a load-bearing file?**

Two deliverables:

- **`validate-diff`** — the engine. Takes a set of changed files, cross-references the existing index, emits findings (duplicate candidates, dangerous-file edits).
- **`guard`** — a git-hook installer that runs `validate-diff` on commit/push. Warn-only by default; blocking is opt-in.

Deferred to later cycles (explicit non-goals here): `validate-plan` (free-text plan checking), GitHub Action packaging, embeddings, multi-language.

## 2. Binding model (decided: index-bound / standalone)

`validate-diff` is **index-bound**: it parses the changed files itself, determines which symbols are *new relative to the index*, and queries the index for look-alikes — plus looks up `importer_count` for every touched file. It requires **no prior `context "<task>"` run**.

Rationale: `guard` is the headline consumer, and a git hook fires with zero knowledge of the developer's "current task." A report-bound model (compare diff against the last `context` report) would fail in unattended hooks. Report-binding can layer on in a later cycle as a bonus check *when* a fresh report exists; it is not the foundation.

## 3. Commands

### `sensei validate-diff [flags]`

Analyze changed TS/JS files against the index; print findings; exit non-zero only in blocking mode.

| Flag | Behavior |
|---|---|
| `--staged` (default) | Changed files from `git diff --cached --name-only --diff-filter=ACMR`. The pre-commit case. |
| `--all` | Also include unstaged working-tree changes (`git diff --name-only HEAD` ∪ staged). |
| `--against <ref>` | Changed files from `git diff --name-only --diff-filter=ACMR <ref>...HEAD`. Pre-push / CI. |
| `--block` | Exit 1 if any finding. Overrides `validate.block` config. |
| `--json` | Emit the Zod-validated `ValidationReport` JSON to stdout instead of the human render. |

Mutually-exclusive source flags resolve by precedence `--against` > `--all` > `--staged`. Only `.ts/.tsx/.js/.jsx` files are analyzed; others are ignored. Deleted files (`--diff-filter` excludes `D`) are not analyzed for duplication but *are* eligible for the dangerous-edit check (deleting a high-fan-in file is risky).

### `sensei guard <action> [flags]`

| Action | Behavior |
|---|---|
| `install` | Write/extend the git hook (default `pre-commit`) so it runs `sensei validate-diff --staged`. Idempotent via managed markers. |
| `uninstall` | Remove the managed block from the hook file, leaving any user content intact. |
| `run` | Execute exactly what the installed hook would (no install). For testing. |

| Flag | Behavior |
|---|---|
| `--hook pre-commit\|pre-push` | Target hook. Default `pre-commit`. `pre-push` installs with `--against @{push}` semantics (falls back to the merge-base with the upstream's default branch when no push ref). |
| `--block` | Installed hook runs `validate-diff --block` (fails the git operation on findings). Default warn-only. |

## 4. The engine (how a finding is produced)

Given the resolved set of changed files:

1. **Resolve changed files** (`src/validate/diff.ts`) via `simple-git` per the source flag. Filter to supported extensions. Posix-normalize paths to match index storage.
2. **Read working-tree content** of each changed file (not the index), so brand-new unscanned files still work. Unreadable/deleted files skip step 3.
3. **Extract symbols** with the existing `ast/extract.ts#extractFromSource(path, source)`.
4. **Determine introduced symbols** (`src/validate/introduced.ts`): a symbol is *introduced* if no symbol with the same `name`+`kind`+`signature` exists for that file path in the index. (Same name+kind but changed signature also counts as introduced — it is new surface area.) This needs a new focused read method `IndexDb.symbolsForFile(path): { name; kind; signature }[]` — the only additive change to an existing MVP module; it is consistent with the existing accessors (`getFileByPath`, `allFiles`).
5. **Duplicate-candidate check** (`src/validate/checks.ts`): for each introduced symbol, reuse `search/search.ts` to retrieve index hits and `scorer/score.ts` to score them against the symbol's own name + signature (treated as the "task" tokens). Take the best hit whose `path` differs from the changed file. If its score ≥ `validate.duplicateThreshold` → emit a `duplicate-candidate` finding.
6. **Dangerous-edit check** (`src/validate/checks.ts`): call `scorer/score.ts#findDangerousFiles(db, config)` once (it already encapsulates both the `dangerous.importerThreshold` rule and entrypoint detection), build a `path → DangerousFile` map, and for each changed file present in that map emit a `dangerous-edit` finding using its `importerCount` + `reason`. No re-implementation of entrypoint matching.
7. **Assemble + render** (`src/validate/report.ts`): build the `ValidationReport`, write `.sensei/last-validation.json`, render human output to stdout.

**Reuse, not reinvention.** Steps 5–6 are new *consumers* of `extract`, `search`, `scorer`, `indexer/db`, and `config`. The duplicate scorer is the same proven similarity logic from `context`; no parallel ranking implementation is created (clean-code DRY).

## 5. Finding model & output

```ts
type FindingKind = 'duplicate-candidate' | 'dangerous-edit';
type Severity = 'warn' | 'block';

interface RelatedSymbol { path: string; line: number; name: string; score: number; }

interface Finding {
  kind: FindingKind;
  severity: Severity;          // 'block' only when blocking mode active, else 'warn'
  file: string;                // changed file (repo-relative, posix)
  line: number;                // symbol start line, or 1 for whole-file dangerous edits
  message: string;             // human sentence, includes the "why"
  related?: RelatedSymbol;     // present for duplicate-candidate
}

interface ValidationReport {
  source: 'staged' | 'all' | string;  // string = the ref for --against
  generatedAt: string;                 // ISO
  findings: Finding[];
  blocked: boolean;                    // true if blocking mode AND findings present
}
```

Zod schema lives in `src/validate/report.ts` (mirrors `report/schema.ts`). Human render groups findings by kind: `DUPLICATE CANDIDATES` then `DANGEROUS EDITS`, each line `file:line — message`. Clean run prints `No findings.` and exits 0.

## 6. Config additions

Extend `ConfigSchema` (`src/config/schema.ts`) with a `validate` block:

```ts
validate: {
  block: boolean;            // default false (warn-only)
  duplicateThreshold: number; // default 0.7, range 0..1
  checkDuplicates: boolean;   // default true
  checkDangerous: boolean;    // default true
}
```

Existing `dangerous.importerThreshold` is reused for the dangerous-edit check — no duplicate threshold introduced.

## 7. Exit codes & severity policy

- **Warn-only is the default.** Findings print; exit code 0. An enforcement tool that blocks on day one gets disabled; adoption first.
- **Blocking** is opt-in via `--block` flag or `validate.block: true`. In blocking mode, any finding sets `report.blocked = true` and the command exits 1.
- **Tooling failures never block by default.** If the index is missing, the command exits 2 with remediation (`run sensei scan`) — but the *installed hook* swallows non-finding errors and exits 0 unless `--block`, so a broken/cold Sensei never wedges a developer's commit.

## 8. Freshness handling

- Changed files are read live from the working tree, so newly-written code needs no prior `scan`.
- The rest of the index (duplicate lookup + `importer_count`) must exist: missing `.sensei/cache.db` → hard error, exit 2, "run `sensei scan` first."
- Stale index (HEAD moved or tracked files changed since `meta.last_scan`) → soft warning printed to stderr, not a failure. Staleness degrades recall, not safety.

## 9. `guard` hook mechanics

- Hooks are written to `$(git rev-parse --git-path hooks)/<hook>` (honors `core.hooksPath`).
- Content is wrapped in managed markers so install/uninstall is surgical and co-exists with existing hook scripts:

```sh
# >>> sensei guard >>>
sensei validate-diff --staged || exit 0   # warn-only: never block
# <<< sensei guard <<<
```

  Blocking install drops the `|| exit 0`. `pre-push` uses `--against` instead of `--staged`.
- If the hook file is new, prepend `#!/bin/sh` and `chmod +x`. If it exists, insert/replace only the managed block.
- The hook invokes `sensei` resolved from the project (`node_modules/.bin/sensei` if present, else PATH). The installer records the resolved invocation so the hook works without a global install.

## 10. Module layout (new files only)

```
src/
  validate/
    diff.ts         # git → changed-file list (staged | all | against)
    introduced.ts   # working-tree extract + index-diff → introduced symbols
    checks.ts       # duplicate-candidate + dangerous-edit producers
    report.ts       # ValidationReport Zod schema + assembly + markdown render
  guard/
    hook.ts         # install / uninstall / run; managed-block hook writer
  core/
    run-validate-diff.ts
    run-guard.ts
  commands/
    validate-diff.ts
    guard.ts
```

Dependency direction: `commands` → `core` → (`validate`, `guard`). `validate` reads `indexer`, `search`, `scorer`, `ast`, `config`. `guard` shells out to the built `validate-diff`. Mirrors the established `core/run-*` orchestration + thin-command pattern.

## 11. Primary risk & mitigations: duplicate false positives

Common names (`handle`, `get`, `validate`, `index`) collide on name alone. A nagging hook gets disabled — the failure mode that kills enforcement tools.

Mitigations, all in this design:
- Require **signature overlap**, not just name: the scorer weights signature tokens, and `duplicateThreshold` (0.7) is high enough that name-only matches fall short.
- **Common-name suppression** via the existing tokenizer stopword/short-token filter — a symbol whose name tokenizes to nothing meaningful is skipped for the duplicate check.
- **Warn-only default** — false positives cost a log line, not a blocked commit, until the team opts into `--block`.
- **Same-file exclusion** — a moved/renamed symbol matching its own prior location (stale index) is excluded by the `path !== changedFile` rule.

## 12. Error handling

- `validate/diff.ts`: not a git repo → exit 2 with message. No changed files → clean exit 0, "No changed files."
- Unparseable changed file → skip it, collect into an end-of-run warning summary (matches scanner behavior); never abort the run.
- `guard`: refuse to install outside a git repo; `uninstall` on a hook with no managed block is a no-op with a notice.
- Boundaries own error handling; the check pipeline stays pure.

## 13. Testing (Vitest)

- **`diff`**: temp git repo fixtures — staged vs working-tree vs `--against` resolution; extension filtering; non-repo error.
- **`introduced`**: a file whose symbol matches the index (not introduced) vs a new/changed-signature symbol (introduced).
- **`checks`**: duplicate above and below threshold; same-file match excluded; common-name suppressed; dangerous-edit above/below `importerThreshold`; entrypoint flagged.
- **`report`**: Zod schema round-trip; human render grouping; clean-run output.
- **`guard/hook`**: install writes runnable managed block; idempotent re-install; uninstall removes only the block; warn-only vs `--block` content; `core.hooksPath` honored.
- **E2E** (extends fixture repo): `scan`, then (a) stage a re-implementation of an existing fixture function → `duplicate-candidate` flagged at the right `path:line` with the related symbol; (b) stage an entrypoint edit → `dangerous-edit` flagged; (c) stage a clean unrelated change → no findings, exit 0; (d) `--block` on (a) → exit 1; (e) `guard install` → hook file runnable, `guard run` reproduces findings, `guard uninstall` → block gone. Determinism invariant: same repo + same staged diff → identical findings.

## 14. Out of scope (this cycle)

`validate-plan` · GitHub Action · embeddings/`sqlite-vec` · multi-language · report-bound validation · auto-`scan` before validate.
