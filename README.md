# Sensei

> Before your AI agent writes code, Sensei tells it what already exists, what to reuse, and what not to touch.

Sensei is a local-first, deterministic CLI for TypeScript/JavaScript repos. It scans your code into a local SQLite symbol index, then produces a ranked "context report" for any task you describe: which existing functions to reuse, and which high-impact files not to casually edit.

## Install (local dev)

```bash
npm install
npm run build
```

> Note: this project uses npm. If you use pnpm and have a `pnpm-workspace.yaml` higher in your home directory, run pnpm commands with `--ignore-workspace`.

## Usage

```bash
sensei init                          # create .sensei/ (config + agent rules)
sensei scan                          # build the local symbol index
sensei context "add password reset"  # write .sensei/current-task-context.md + reuse-candidates.json
sensei export --target claude        # print a Claude-ready context block
```

## Enforcement

After your agent writes code, check the diff against the index:

```bash
sensei validate-diff                  # check staged changes (warn-only)
sensei validate-diff --against main   # check this branch vs main
sensei validate-diff --block          # exit non-zero on any finding (for CI/hooks)
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

## How it works

1. `scan` walks the repo (respecting `.gitignore`), parses TS/JS with `ts-morph`, and indexes symbols + the import graph into `.sensei/cache.db` (SQLite + FTS5). Re-scans are incremental via per-file content hashing.
2. `context` tokenizes your task, retrieves candidate symbols via FTS5, and scores them with a deterministic heuristic (name/signature overlap, path/domain match, exported, git-recency, tests-nearby). It also flags high-fan-in "do not touch" files.
3. `export` renders the latest report for an AI agent.

No API key. No network. Same repo + same task = same ranking.

## Configuration

`.sensei/sensei.config.json` controls include/ignore globs, `context.topN`, scoring weights, and the dangerous-file `importerThreshold`.

## Development

```bash
npm test         # run the vitest suite
npm run typecheck
npm run build
```

## Status

MVP + enforcement. Shipped: `init` / `scan` / `context` / `export`, plus `validate-diff` / `guard`. Planned next: `validate-plan`, GitHub Action, embeddings, multi-language, and Cursor/Codex exporters.
