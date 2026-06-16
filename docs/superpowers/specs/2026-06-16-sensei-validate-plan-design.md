# Sensei — `validate-plan` Design (Enforcement, Phase 2.2)

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Builds on:** `docs/superpowers/specs/2026-06-16-sensei-validate-diff-design.md` (enforcement engine) and `docs/superpowers/specs/2026-06-16-sensei-design.md` (MVP). Assumes the index, config, scanner, AST, search, scorer, MVP report, and the `validate-diff` engine (`src/validate/*`) exist and are committed.

**PRD alignment:** Implements `validate-plan` from PRD §11 (CLI Interface) and PRD Roadmap Phase 2 "Agent Guard Mode → Plan validation". Serves PRD Feature 2 (reuse-first), Feature 4 (dangerous file detection), and Feature 6 (hook/guard violation surface) at the *plan* stage — before the agent writes code.

---

## 1. Summary

`validate-diff` checks code **after** it is written: did the diff re-implement something that exists, and did it touch a load-bearing file? `validate-plan` moves the same judgment **earlier** — to the agent's written plan, before any code exists:

> **Given an agent's free-text plan, does it propose creating something that already exists (reuse violation), or propose touching a dangerous file?**

One deliverable:

- **`validate-plan <plan.md>`** — parse an agent's plan into proposed targets (files/symbols), cross-reference the existing index, emit findings (`reuse-candidate`, `dangerous-target`). Warn-only by default; blocking opt-in.

The finding shape, severity policy, and report schema are **shared with `validate-diff`** (§5). The only thing new is the *source* of proposed symbols: parsed prose instead of a git diff.

## 2. Binding model (decided: index-bound / standalone)

`validate-plan` is **index-bound**, mirroring `validate-diff`: it parses the plan itself, derives proposed targets, and queries the index for look-alikes plus dangerous-path matches. It requires a prior `sensei scan`, but **no prior `context "<task>"` run** and no `.sensei/` report.

Rationale: index-binding is the proven, smaller, reuse-heavy path; it keeps `validate-plan` runnable standalone (including future CI / hook use). Report-bound enrichment (fold in the last `context` report when a fresh one exists) is a deliberate later-cycle growth path — the pluggable check registry (§4) makes it cheap to add without rewiring.

## 3. Command

### `sensei validate-plan <plan.md> [flags]`

Parse a plan file (or stdin), analyze proposed targets against the index, print findings; exit non-zero only in blocking mode.

| Flag / arg | Behavior |
|---|---|
| `<plan.md>` (positional, required unless `--stdin`) | Path to the agent's plan markdown. |
| `--stdin` | Read the plan from stdin instead of a file (pipe an agent's plan directly). |
| `--block` | Exit 1 if any finding. Overrides `validate.block` config. |
| `--json` | Emit the Zod-validated `ValidationReport` JSON to stdout instead of the human render. |

`<plan.md>` and `--stdin` are mutually exclusive; if both are absent the command errors (exit 2). The plan is parsed as markdown/plain text; no execution.

## 4. The engine (how a finding is produced)

### 4.1 Plan parsing — `src/validate/plan-parse.ts`

Parses the plan text into `ProposedTarget[]` using a **hybrid** strategy (structured sections when present, heuristic fallback always).

```ts
interface ProposedTarget {
  kind: 'file' | 'symbol';
  value: string;                 // posix path (file), or symbol name (symbol)
  action: 'create' | 'modify' | 'unknown';
  line: number;                  // 1-based line in the plan, for finding location
  confidence: 'high' | 'low';    // high = structured section, low = heuristic
}
```

**Structured pass (high confidence).** Recognizes known section headers, case-insensitive, at any markdown heading level: `Files`, `Files to Create`, `Files to Modify`, `Files to Change`, `New Symbols`, `Functions`, `Classes`. List items (`-`, `*`, `1.`) beneath such a header become targets until the next heading. `action` is inferred from the header verb: contains create/new/add → `create`; contains modify/change/edit/update → `modify`; otherwise `unknown`. Header naming a symbol category (`New Symbols`/`Functions`/`Classes`) yields `kind: 'symbol'`; `Files*` yields `kind: 'file'`.

**Heuristic pass (low confidence, always runs; merged + deduped with structured results).**
- **Files:** tokens matching a path-like regex ending in `.ts/.tsx/.js/.jsx`, whether inside backticks, fenced code, or bare prose.
- **Symbols:** backtick-delimited identifiers; `PascalCase` identifiers (types/classes); `camelCase(` call-shaped identifiers (functions/methods). Each candidate is filtered through the **existing `text/tokenize` stopword + short-token filter**; a candidate that tokenizes to nothing meaningful is dropped. This directly mitigates PRD Risk 4 (false positives) and reuses the same suppression `validate-diff` relies on.
- **Action inference:** scan the candidate's own line/sentence for verbs — create/add/new/introduce → `create`; modify/extend/update/change/reuse → `modify`; else `unknown`.

**Merge + dedup:** combine both passes, dedup by `(kind, value)`. On collision, keep the higher-confidence (structured) entry and its `action`/`line`.

**Why `action` matters:** `reuse-candidate` fires only for `create`/`unknown` intent (proposing NEW surface that duplicates existing). A declared `modify` of an existing symbol/file is the desired behavior and is never flagged for reuse. `dangerous-target` fires for *any* action whose path matches a dangerous rule.

### 4.2 Checks — pluggable registry in `src/validate/plan-checks.ts`

```ts
interface PlanCheckContext { targets: ProposedTarget[]; db: IndexDb; config: Config; }

interface PlanCheck {
  kind: FindingKind;
  enabled(config: Config): boolean;
  run(ctx: PlanCheckContext): Finding[];
}

const PLAN_CHECKS: PlanCheck[] = [reuseCandidateCheck, dangerousTargetCheck];
```

Pipeline: `PLAN_CHECKS.filter(c => c.enabled(config)).flatMap(c => c.run(ctx))`. Adding a future check (e.g. pattern-violation, or report-bound enrichment) is appending one registry entry — zero rewiring. This is the scalability seam.

**1. `reuseCandidateCheck`** — gated by `validate.checkDuplicates`.

A plan declares intent by **name only** — it has no function signature yet. The shared 50/50 name+signature `symbolSimilarity` (used by `validate-diff`, where the new code's signature *is* known) caps a signatureless input at 0.5 and could never reach the 0.7 default. Plan reuse therefore scores with a purpose-built **name-containment** metric (`nameContainment`, §4.3): how much of an *existing* symbol's meaningful tokens are echoed by the proposed name.

- For each proposed **symbol** with `create`/`unknown` action: retrieve index hits via `search/search.ts` (FTS5 over the proposed name's tokens); score each cross-target hit with `nameContainment(proposedName, hit.name)`; best hit ≥ `validate.duplicateThreshold` → `reuse-candidate` finding "plan proposes `X`; existing `Y` at `path:line` already covers this — extend it instead of creating new." Example: `PartialRefundService` (`{partial, refund, service}`) vs existing `RefundService` (`{refund, service}`) → containment `2/2 = 1.0` → fires; `PaymentService` vs `RefundService` → `{service}/2 = 0.5` → does not.
- For each proposed **file** with `create` action: compare the proposed file's basename-without-extension against every indexed file's basename via the same `nameContainment`; best ≥ threshold and `path` ≠ proposed path → `reuse-candidate` (e.g. plan's `refund-v2.service.ts` → `{refund, v2, service}` vs indexed `refund.service.ts` → `{refund, service}` → `1.0`).

**Single-token guard (false-positive control):** `nameContainment` returns 0 when the *existing* symbol tokenizes to a single token unless the proposed name is exactly that one token. This stops a short common name like `validate` from matching every `validate*` proposal while still catching exact duplicates.

**2. `dangerousTargetCheck`** — gated by `validate.checkDangerous`.
- Source is the **union** of two rules (a deliberate difference from `validate-diff`, which only consults the index map of existing files):
  1. **Config glob match:** the proposed file path matches a `config.dangerous.paths` glob. This catches **proposed new files that do not exist in the index yet** (e.g. a new `src/modules/payment/refund-v2.service.ts`). Matching uses the already-installed `ignore` dependency (gitignore-style semantics), wrapped in a small `src/validate/glob.ts` helper so the dependency choice is isolated behind one interface.
  2. **Index map match:** `scorer/score.ts#findDangerousFiles(db, config)` map (importer-threshold + entrypoint rules) for proposed paths that already exist.
- Each match → `dangerous-target` finding with the matching reason. A path matched by both rules yields one finding (config-glob reason takes precedence).

**Config gap closed:** the shipped MVP `ConfigSchema` has only `dangerous.importerThreshold` — no glob list, despite PRD §12 listing `dangerousPaths`. This cycle adds **one** new config key, `dangerous.paths` (§6), which the config-glob rule consumes. This is the only new config key in this cycle.

### 4.3 Shared similarity — `src/validate/similarity.ts`

The similarity primitives currently inlined in `validate-diff`'s `src/validate/checks.ts` are **extracted** into `src/validate/similarity.ts`, which becomes the single home for token-based comparison built on the shared `tokenize`:

- `jaccard(a, b)` — symmetric token-Jaccard (private helper, exported for reuse).
- `symbolSimilarity(a, b)` — 50/50 name+signature Jaccard. Used by `checks.ts` (diff). Unchanged behavior.
- `nameContainment(proposedName, existingName)` — `|tokens(proposed) ∩ tokens(existing)| / |tokens(existing)|`, with the single-token guard (§4.2). Used by `plan-checks.ts` (plan).

`checks.ts` re-exports `symbolSimilarity` from `similarity.ts` so existing importers (e.g. `validate-checks.test.ts`) keep resolving. No parallel ranking logic is created (clean-code DRY). `validate-diff`'s existing tests must stay green across the extraction.

### 4.4 Assemble + render — extend `src/validate/report.ts`

Build the `ValidationReport`, write `.sensei/last-plan-validation.json`, render human output to stdout.

## 5. Finding model & output (shared schema, extended)

The existing `validate-diff` schema in `src/validate/report.ts` is extended in place — no parallel schema:

```ts
type FindingKind =
  | 'duplicate-candidate' | 'dangerous-edit'   // existing (validate-diff)
  | 'reuse-candidate' | 'dangerous-target';    // new (validate-plan)

type Severity = 'warn' | 'block';

interface RelatedSymbol { path: string; line: number; name: string; score: number; }

interface Finding {
  kind: FindingKind;
  severity: Severity;          // 'block' only when blocking mode active, else 'warn'
  file: string;                // proposed target (repo-relative, posix)
  line: number;                // line in the PLAN for plan findings
  message: string;             // human sentence, includes the "why"
  related?: RelatedSymbol;     // present for reuse-candidate
}

interface ValidationReport {
  source: 'staged' | 'all' | 'plan' | string;  // 'plan' added; string = --against ref (diff)
  generatedAt: string;                          // ISO
  findings: Finding[];
  blocked: boolean;                             // true if blocking mode AND findings present
}
```

`source: 'plan'` is added to the union. Human render groups plan findings: `REUSE CANDIDATES` then `DANGEROUS TARGETS`, each line `target:line — message`. Clean run prints `No findings.` and exits 0. Plan output is written to `.sensei/last-plan-validation.json` so it never clobbers `validate-diff`'s `.sensei/last-validation.json`.

`--json` always emits a valid `ValidationReport`, including on empty/clean runs — a stable contract for the future GitHub Action / dashboard.

## 6. Config

**Reuse the existing `validate` block** from the `validate-diff` cycle (no changes):

```ts
validate: {
  block: boolean;             // default false (warn-only)
  duplicateThreshold: number; // default 0.7 — gates reuse-candidate similarity
  checkDuplicates: boolean;   // default true — gates reuseCandidateCheck
  checkDangerous: boolean;    // default true — gates dangerousTargetCheck
}
```

**One new key** is added to the existing `dangerous` block — `paths`, the glob list the config-glob rule (§4.2) consumes:

```ts
dangerous: {
  importerThreshold: number;  // existing, default 5
  paths: string[];            // NEW, default [] — gitignore-style globs for dangerous-by-path
}
```

`dangerous.importerThreshold` (entrypoint + importer rules via `findDangerousFiles`) and the new `dangerous.paths` globs together drive the dangerous-target check. Default `[]` keeps behavior opt-in and backward-compatible: existing configs gain the key with an empty default and see no change until they populate it.

## 7. Exit codes & severity policy (mirrors validate-diff §7)

- **Warn-only is the default.** Findings print; exit 0.
- **Blocking** is opt-in via `--block` or `validate.block: true`. Any finding sets `report.blocked = true` and exits 1.
- **Exit 2 (tooling error, never a "finding"):**
  - plan file missing/unreadable, or neither `<plan.md>` nor `--stdin` given → message + exit 2.
  - missing index (`.sensei/cache.db` absent) → `run sensei scan first`, exit 2.
- **Exit 0 clean cases:** plan parses to zero targets → `No actionable targets found in plan.` ; targets found, no findings → `No findings.`

## 8. Freshness handling (mirrors validate-diff §8)

- The plan is read live; proposed files need not exist or be scanned.
- The index (duplicate lookup + `importer_count` + entrypoint detection) must exist: missing `.sensei/cache.db` → hard error, exit 2.
- Stale index (HEAD moved or tracked files changed since `meta.last_scan`) → soft warning to stderr, not a failure. Staleness degrades recall, not safety.

## 9. Module layout (new files only)

```
src/
  validate/
    plan-parse.ts      # plan text → ProposedTarget[] (structured + heuristic hybrid)
    plan-checks.ts     # PlanCheck registry: reuse-candidate + dangerous-target producers
    similarity.ts      # extracted shared symbol-similarity (DRY w/ checks.ts)
    glob.ts            # dangerous.paths glob matcher (wraps `ignore` dep)
    report.ts          # EXTEND: FindingKind union, source 'plan', plan writer/render
  core/
    run-validate-plan.ts
  commands/
    validate-plan.ts
```

Dependency direction unchanged: `commands → core → validate`. `validate` reads `indexer`, `search`, `scorer`, `config`, `text/tokenize`. No `ast` dependency (a plan has no code to parse). Mirrors the established `core/run-*` orchestration + thin-command pattern.

## 10. Primary risk & mitigations: extraction false positives

A plan is prose; over-eager symbol extraction flags noise, and a nagging tool gets ignored (PRD Risk 4). Mitigations, all in this design:

- **Tokenizer suppression** — every heuristic symbol candidate passes the existing stopword/short-token filter; prose words that tokenize to nothing are dropped. A proposed target whose name tokenizes to nothing is skipped for the reuse check.
- **Containment single-token guard** — `nameContainment` (§4.2) refuses to fire on a single-token existing name unless the proposed name matches it exactly, so common short names (`validate`, `index`, `handler`) don't match every echo.
- **Action gating** — declared `modify` intent never raises a reuse finding; only `create`/`unknown` do.
- **Warn-only default** — false positives cost a log line, not a blocked workflow, until the team opts into `--block`.
- **Confidence field** — structured (`high`) vs heuristic (`low`) confidence is carried on every target, available to gate output verbosity or future thresholds without re-parsing.

## 11. Error handling

- `commands`/`core` boundaries own error handling; the parse + check pipeline stays pure.
- Unparseable / malformed plan markdown never aborts — worst case yields zero targets and a clean "no targets" exit.
- Missing file, missing index, and bad invocation produce exit 2 with remediation text.

## 12. Testing (Vitest)

- **`plan-parse`**: structured sections extracted with correct `kind`/`action`; heuristic fallback on a prose-only plan; dedup (structured beats heuristic on collision); stopword/short-token suppression; action inference (create vs modify vs unknown); `--stdin` source.
- **`plan-checks`**: reuse above and below `duplicateThreshold`; `modify`-action symbol never flagged; a proposed **new** file under a `dangerousPaths` glob flagged even though absent from the index; index-map dangerous match flagged; common-name suppressed; same-file exclusion for reuse.
- **`similarity`**: extracted helper produces identical scores to the pre-extraction inline version (guards the DRY refactor; `validate-diff` tests remain green).
- **`report`**: Zod round-trip with the new `FindingKind`s and `source: 'plan'`; human render grouping; clean-run output; `.sensei/last-plan-validation.json` written (and `last-validation.json` untouched).
- **E2E** (extends the fixture repo): `scan`, then —
  - (a) a plan proposing `PartialRefundService` that duplicates an existing fixture symbol → `reuse-candidate` at the correct `path:line` with the related symbol.
  - (b) a plan proposing a file under a dangerous path → `dangerous-target`.
  - (c) a clean unrelated plan → `No findings.`, exit 0.
  - (d) `--block` on (a) → exit 1.
  - (e) `--json` → schema-valid `ValidationReport`.
  - Determinism invariant: same plan + same index → identical findings.

## 13. Out of scope (this cycle)

Report-bound enrichment (fold in the last `context` report) · pattern-violation check · GitHub Action packaging · embeddings/`sqlite-vec` · multi-language · synthesizing symbols from proposed filenames beyond basename similarity · auto-`scan` before validate.
