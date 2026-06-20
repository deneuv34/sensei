# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-06-20

### Added

- **Cursor and Codex export targets** — `sensei export --target cursor|codex` renders the reuse/danger context report as markdown (Cursor as MDC with `alwaysApply` frontmatter, Codex as plain `AGENTS.md` markdown). `renderClaude` is unchanged.
- **`--write` / `-w` flag for `export`** — writes the rendered context into each tool's native rule file: Cursor's dedicated `.cursor/rules/sensei.mdc` (whole-file, frontmatter must lead) and Codex's shared `AGENTS.md` via an idempotent managed section delimited by `<!-- SENSEI:START -->` / `<!-- SENSEI:END -->` that preserves surrounding user content. `--write` is rejected for `--target claude` (no canonical native file); without `--write`, behavior is unchanged (render to stdout, no disk writes).

## [0.7.0] - 2026-06-18

### Added

- **Multi-language support via Tree-sitter** — Python, Go, Rust, and Java are now indexed for code-reuse detection (`context`, `validate-diff`, `validate-plan`). TS/JS continue to use the TypeScript compiler; the four new languages use a `web-tree-sitter` backend with one query-driven `LangSpec` each. Grammar `.wasm` binaries are vendored, so installs stay network-free and deterministic.

### Notes

- Import-graph / high-fan-in "dangerous" detection remains TS/JS-only for now; the new languages rely on `dangerous.paths` globs.
- Existing repos with a written `.sensei/sensei.config.json` keep their `include` globs — add language patterns (e.g. `"**/*.py"`) and re-run `sensei scan` to pick up the new languages. Fresh `sensei init` includes them by default.

## [0.6.0] - 2026-06-16

### Added

- **GitHub Action** — a reusable composite action (`uses: deneuv34/sensei@v1`) that gates pull requests. It builds the index from the **base** ref, then runs `validate-diff` against it, so symbols the PR introduces are correctly detected. Warn-only by default; set `block: true` to fail the check on findings. Requires `actions/checkout` with `fetch-depth: 0`. Inputs: `version`, `base`, `block`, `working-directory`, `node-version`. Outputs: `blocked`, `findings`, `report-path`.

### Notes

- The action scans the base tree (checkout base → `scan` → return to HEAD) rather than HEAD. Scanning HEAD would index the PR's new code, leaving nothing "introduced" for reuse detection to flag.

## [0.5.0] - 2026-06-16

### Added

- **Shell autocomplete** — added oclif autocomplete support for `zsh`, `bash`, and `powershell` via `sensei autocomplete <shell>`.

## [0.4.0] - 2026-06-16

### Added

- **`validate-plan <plan.md>`** — check an agent's written plan *before* it writes code (the early counterpart to `validate-diff`). Parses the plan into proposed files/symbols and emits two finding kinds:
  - `reuse-candidate`: the plan proposes creating a file/symbol whose name echoes existing code (scored by name-containment, since a plan has no signatures yet — default threshold `0.7`). Extend it instead of creating new.
  - `dangerous-target`: the plan proposes touching a `dangerous.paths` glob, a high-fan-in file, or an entrypoint — including **proposed new files that do not exist in the index yet**.
  - Input: a plan file argument or `--stdin`. Flags: `--block` (non-zero exit on findings), `--json`. Writes `.sensei/last-plan-validation.json`.
- **Hybrid plan parser** — reads explicit `## Files` / `## New Symbols` sections when present, with a heuristic fallback over prose (compound-name and code-token extraction, tokenizer stopword suppression).
- **`dangerous.paths`** config — gitignore-style globs marking files as dangerous by path, consumed by `validate-plan` (and available to `validate-diff`).

### Changed

- Extracted the token-similarity helpers into `src/validate/similarity.ts` (shared by `validate-diff` and `validate-plan`); added `nameContainment`. Behavior of the existing `validate-diff` similarity is unchanged.

### Notes

- 39 new tests (101 total). Deterministic, no network, no API key. Backward-compatible: `dangerous.paths` defaults to `[]`.

## [0.3.0] - 2026-06-16

### Added

- **Live `scan` terminal UI** — a four-phase `listr2` progress display (Discover → Git history → Parse & index → Resolve) with per-file detail, so large-repo scans never look frozen. Auto-falls back to plain output when piped / non-TTY.
- **`scan --verbose`** — list all warnings instead of a collapsed count.

### Changed

- **Scan performance**: git metadata is now collected in a **single** `git log` pass instead of one `git log` per file. A repo of N source files went from `1 + N` git subprocess spawns to **2 total**, eliminating the multi-minute stall on large projects.
- **AST extraction** rewritten on the raw `typescript` compiler API (`ts.createSourceFile`, no type-checker) in place of `ts-morph` — faster parsing and a lighter dependency. The parser is now error-tolerant on malformed syntax.

### Fixed

- Scan no longer deadlocks (and surfaces the real error) when an underlying failure occurs mid-scan.

### Notes

- 7 new tests (62 total). Deterministic, no network, no API key.

## [0.2.0] - 2026-06-16

### Added

- **`validate-diff`** — check changed files against the index for two finding kinds:
  - `duplicate-candidate`: a newly introduced symbol closely matches existing code (token-Jaccard similarity of ½ name + ½ signature, default threshold `0.7`).
  - `dangerous-edit`: a change touches a high-fan-in or entrypoint file.
  - Modes: `--staged` (default), `--all`, `--against <ref>`. Flags: `--block` (non-zero exit on findings), `--json`. Writes `.sensei/last-validation.json`.
- **`guard`** — install/uninstall/run a git hook that runs `validate-diff`:
  - Idempotent **managed block** that coexists with existing hook content.
  - `--hook pre-commit|pre-push`, `--block`.
  - Warn-only by default; never breaks a commit on tooling error unless `--block`.
- `validate` configuration block: `duplicateThreshold`, `block`, `checkDuplicates`, `checkDangerous`.

### Notes

- 27 new tests (55 total). Deterministic, no network, no API key.

## [0.1.0] - 2026-06-16

### Added

- **`init`** — scaffold `.sensei/` (config + agent rules).
- **`scan`** — build a local SQLite symbol index (ts-morph + SQLite FTS5), incremental via per-file content hashing.
- **`context`** — ranked reuse candidates + high-fan-in "do not touch" files for a described task.
- **`export`** — render the latest context report for an AI agent (`--target claude`).

[0.7.0]: https://github.com/deneuv34/sensei/releases/tag/v0.7.0
[0.6.0]: https://github.com/deneuv34/sensei/releases/tag/v0.6.0
[0.5.0]: https://github.com/deneuv34/sensei/releases/tag/v0.5.0
[0.4.0]: https://github.com/deneuv34/sensei/releases/tag/v0.4.0
[0.3.0]: https://github.com/deneuv34/sensei/releases/tag/v0.3.0
[0.2.0]: https://github.com/deneuv34/sensei/releases/tag/v0.2.0
[0.1.0]: https://github.com/deneuv34/sensei/releases/tag/v0.1.0
