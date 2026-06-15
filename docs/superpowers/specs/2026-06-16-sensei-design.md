# Sensei — MVP Design (Thin Vertical Slice)

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Source:** Derived from the "PRD Stack Proposal" ChatGPT conversation. The raw PRD was an uploaded file not embedded in the public share; this design reconstructs requirements from the assistant's stack proposal and the brainstorming session.

---

## 1. Product summary

Sensei is a CLI-first developer tool for TypeScript/JavaScript repositories. Its single wedge:

> **Before an AI coding agent writes code, Sensei tells it what already exists, what to reuse, and what not to touch.**

It scans a repo deterministically (no AI required), builds a local symbol/import index, and on demand produces a ranked "context report" for a described task: reuse candidates, dangerous files, and agent rules. The report is consumable by humans and exportable into a Claude-ready block.

## 2. Goals & non-goals

**Goals (this slice):**
- Prove the wedge end-to-end on a single TS/JS repo, fully deterministic (no API key).
- Four working commands: `init`, `scan`, `context`, `export --target claude`.
- Fast, incremental scanning; reproducible ranked output; clean module boundaries that can later split into a monorepo.

**Non-goals (deferred to Phase 2+):**
- `guard` / `validate-plan` / `validate-diff` (hook mode).
- Embeddings / vector search (`sqlite-vec`).
- Multi-language support (Tree-sitter; Go/Python/Java/etc.).
- Cursor / Codex exporters (stubbed only).
- Team SaaS (NestJS, Postgres, GitHub App, dashboard).

## 3. Approach (selected: A)

**A — Symbol index + keyword (FTS5) + heuristic scorer, deterministic.** Chosen over (B) hybrid+embeddings and (C) keyword/grep-only. A matches the proposal's MVP recommendation, requires no API key, is fully reproducible, and lets embeddings (B) layer on later without restructuring. C was rejected because dropping AST analysis discards the symbol-level intelligence that differentiates Sensei from `grep`.

## 4. Commands & end-to-end flow

| Command | Behavior |
|---|---|
| `sensei init` | Create `.sensei/`: write `sensei.config.json` (Zod-defaulted), add cache to ignore, write a default `agent-rules.md`. Idempotent. |
| `sensei scan` | Walk repo (respect `.gitignore` + config ignore) → parse TS/JS with ts-morph → extract symbols + import graph + git metadata → write `.sensei/cache.db`. Incremental via per-file content hash (re-parse only changed files). |
| `sensei context "<task>"` | Query the index → build a ranked context report → write `.sensei/current-task-context.md` + `.sensei/reuse-candidates.json`; print a summary to stdout. Errors clearly if no cache (instructs `scan`). |
| `sensei export --target claude` | Render the latest context report into a Claude-ready fenced markdown block to stdout. `cursor`/`codex` targets recognized but stubbed (clear "not yet implemented" message). |

Canonical flow: `init → scan → context "add password reset" → export --target claude`.

## 5. Architecture — single package, clean module boundaries

Single npm package named `sensei`. Internal modules are isolated behind small typed interfaces so they can become separate packages later. oclif commands are thin orchestrators only.

```
src/
  cli/         # oclif commands: init, scan, context, export
  config/      # Zod-validated sensei.config.json load + defaults
  scanner/     # fast-glob + ignore + simple-git -> file list + git metadata
  ast/         # ts-morph: symbol extraction + import-graph extraction
  indexer/     # SQLite open/migrate, write/read, FTS5, incremental hashing
  search/      # FTS5 + symbol-name query against the index
  scorer/      # reuse ranking + dangerous-file detection (core IP)
  report/      # assemble context report -> markdown + JSON (Zod schema)
  exporters/   # target renderers (claude implemented; cursor/codex stub)
```

Dependency direction: `cli` → (`config`, `scanner`, `ast`, `indexer`, `search`, `scorer`, `report`, `exporters`). `scanner`/`ast` feed `indexer`; `search`+`scorer` read `indexer`; `report` consumes `scorer`; `exporters` consume `report` output.

## 6. Data model (SQLite)

```sql
files(
  id INTEGER PK, path TEXT UNIQUE, hash TEXT, lang TEXT, loc INTEGER,
  git_last_modified INTEGER, git_commit_count INTEGER, importer_count INTEGER
)
symbols(
  id INTEGER PK, file_id INTEGER FK, kind TEXT, name TEXT, signature TEXT,
  exported INTEGER, start_line INTEGER, jsdoc TEXT
)   -- kind in {function,class,method,interface,type,const,enum}
imports(
  id INTEGER PK, file_id INTEGER FK, module TEXT,
  imported_name TEXT, resolved_file_id INTEGER NULL
)
symbols_fts  -- FTS5 virtual table over (name, signature, jsdoc, path)
meta(key TEXT PK, value TEXT)  -- schema version, last scan time, repo root
```

- `files.hash` (content hash) drives incremental re-scan.
- `imports.resolved_file_id` builds the fan-in graph; `files.importer_count` is derived from it and powers dangerous-file detection.

## 7. Reuse engine (core)

`context "<task>"` pipeline:

1. **Tokenize** the task string: split, lowercase, drop stopwords, keep identifiers and domain nouns.
2. **Retrieve** candidates: FTS5 match over tokens → symbol + file hits.
3. **Score** each candidate to a 0–1 value, a weighted sum of:
   - name/signature token overlap with the task,
   - path/domain match (e.g. token "auth" → `src/auth/**`),
   - `exported` boost (public API more reusable),
   - git-recency (recently touched ranks higher),
   - test-exists boost (a matching `*.test.*` / `*.spec.*` nearby).
4. **Dangerous files**: flag high `importer_count` (many dependents → "don't casually edit"), plus entrypoints/config files.
5. **Assemble report**: top-N reuse candidates (default N=10, configurable via `sensei.config.json`) as (`path:line`, signature, why-matched reasons), dangerous files, and applicable rules read from `agent-rules.md`.

Scoring weights live in `sensei.config.json` so they are tunable without code changes. Default weights are defined in `config/` defaults.

## 8. Outputs

- `.sensei/current-task-context.md` — human/agent-readable report: task echoed, reuse candidates, dangerous (don't-touch) files, agent rules.
- `.sensei/reuse-candidates.json` — Zod-validated structured form for later automation/hooks.
- `export --target claude` → a single fenced context block leading with reuse candidates + don't-touch list, formatted to paste or pipe into Claude Code.

## 9. Tech stack

Locked (per proposal): TypeScript, Node.js 22+, pnpm, **oclif**, tsup (build), ts-morph (AST), fast-glob + ignore + simple-git + micromatch (scan), better-sqlite3 + SQLite FTS5 (storage), Zod (config + output schemas), Vitest (tests), Changesets + GitHub Actions + npm (release).

**Deviation from proposal — approved:** use **raw `better-sqlite3` with a small typed data-access module instead of Drizzle ORM** for the MVP. Rationale: FTS5 virtual tables require hand-written SQL regardless, and the index workload is simple and write-heavy; this keeps the dependency and abstraction surface minimal. Drizzle can be introduced later if migrations become valuable.

## 10. Error handling

- Errors handled at boundaries; logic stays clean.
- `scanner`/`ast`: skip unreadable or unparseable files, collect them into a warning summary printed at end of scan. A bad file never aborts the whole scan.
- `config`: Zod validation with human-readable messages on malformed `sensei.config.json`.
- `context` / `export`: fail clearly with remediation ("run `sensei scan` first") if `.sensei/cache.db` is missing or stale.
- Non-zero exit codes on hard failures; warnings do not fail the command.

## 11. Testing (Vitest)

- Unit tests per module; `scorer` and `ast` extraction get the densest coverage (they hold the product logic).
- One end-to-end test: run `init → scan → context "<task>"` against a small fixture repo committed under `test/fixtures/`, asserting the ranked candidates and dangerous-file output.
- Deterministic output is a test invariant: same repo + same task string → identical ranking.

## 12. Phase 2 (explicitly out of scope now)

`guard` (warn-only then blocking) · `validate-plan` · `validate-diff` · embeddings/`sqlite-vec` · Tree-sitter multi-language · Cursor/Codex exporters · pre-commit/pre-push + GitHub Action · team SaaS stack.
