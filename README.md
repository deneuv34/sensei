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

MVP (thin vertical slice). Planned next: `guard` / `validate-plan` / `validate-diff`, embeddings, multi-language, and Cursor/Codex exporters.
