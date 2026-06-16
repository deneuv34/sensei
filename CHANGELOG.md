# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.3.0]: https://github.com/deneuv34/sensei/releases/tag/v0.3.0
[0.2.0]: https://github.com/deneuv34/sensei/releases/tag/v0.2.0
[0.1.0]: https://github.com/deneuv34/sensei/releases/tag/v0.1.0
