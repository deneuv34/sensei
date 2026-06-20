# Sensei

> Before your AI agent writes code, Sensei tells it what already exists, what to reuse, and what not to touch.

Sensei is a **local-first, deterministic** CLI for TypeScript/JavaScript, Python, Go, Rust, and Java repos. No API key, no network, no LLM in the loop. It scans your code into a local SQLite symbol index, then answers two questions an AI coding agent almost never gets right on its own:

1. **What already exists here that I should reuse?**
2. **Which files are load-bearing and dangerous to touch?**

---

## Why Sensei?

AI coding agents are powerful and context-blind. Dropped into a real repo, they reliably make the same expensive mistakes:

- **They reimplement what's already there.** The agent writes a new `formatCurrency`, `getUser`, or `validateEmail` because it never saw the one you already shipped three folders away. Now you maintain two.
- **They edit the wrong files.** The agent casually rewrites your DI entrypoint, a 15-importer types module, or the auth barrel — the exact files where a small mistake breaks everything.
- **They have no memory of your codebase.** Every session starts cold. The agent's "context" is whatever happened to fit in the prompt, not what's actually in the repo.

The usual fix — stuffing the whole codebase into the model's context — is slow, expensive, non-deterministic, and still misses things. Sensei takes the opposite approach: **a cheap, deterministic index that hands the agent a short, ranked, factual brief before it writes a line.**

Same repo + same task = same answer, every time. You can diff it, cache it, and trust it in CI.

```
You: "add password reset"
        │
        ▼
   sensei context "add password reset"
        │
        ▼
   ┌────────────────────────────────────────────┐
   │ REUSE: src/auth/token.ts:12 issueToken()    │
   │ REUSE: src/mail/send.ts:8 sendEmail()       │
   │ AVOID: src/types.ts (15 importers)          │
   │ AVOID: src/index.ts (entrypoint)            │
   └────────────────────────────────────────────┘
        │
        ▼
   feed to your agent → it reuses instead of reinventing
        │
        ▼
   sensei validate-diff  → catches duplicates/dangerous edits before commit
```

---

## Install

Requires Node `>=22`.

```bash
npm install -g @deneuv34/sensei
```

This installs the `sensei` command. Or build from source:

```bash
git clone https://github.com/deneuv34/sensei.git
cd sensei
npm install
npm run build
npm link        # optional: put `sensei` on your PATH
```

> This project uses npm. If you use pnpm and have a `pnpm-workspace.yaml` higher in your home directory, run pnpm commands with `--ignore-workspace`.

## Quickstart

```bash
sensei init                          # create .sensei/ (config + agent rules)
sensei scan                          # build the local symbol index
sensei context "add password reset"  # write .sensei/current-task-context.md
sensei export --target claude        # print a Claude-ready context block
```

Pipe the export straight into your agent's prompt, or point the agent at `.sensei/current-task-context.md`.

## Enforcement

`context` is advice up front. `validate-diff` is a check after the fact: it compares the changed code against the index and flags two things.

```bash
sensei validate-diff                  # check staged changes (warn-only)
sensei validate-diff --against main   # check this branch vs main
sensei validate-diff --all            # check the whole working tree
sensei validate-diff --block          # exit non-zero on any finding (for CI/hooks)
sensei validate-diff --json           # machine-readable output
```

| Finding | Meaning |
|---|---|
| **duplicate-candidate** | A newly introduced symbol closely matches existing code (token-Jaccard similarity ≥ threshold). Reuse it instead of reimplementing. |
| **dangerous-edit** | You touched a high-fan-in or entrypoint file — the kind where a small mistake has wide blast radius. |

The JSON form is always written to `.sensei/last-validation.json`.

Wire it into git so it runs automatically:

```bash
sensei guard install                  # warn-only pre-commit hook
sensei guard install --block          # block commits on findings
sensei guard install --hook pre-push  # run on push instead
sensei guard run                      # run the check manually
sensei guard uninstall
```

The hook is installed as an idempotent **managed block** — it coexists with any hook content you already have. It never breaks your commit on a tooling error (missing index, parse failure) unless you installed it with `--block`.

### Before code: `validate-plan`

`validate-diff` checks code after it is written. `validate-plan` moves the same judgment earlier — to the agent's written plan, before any code exists. Hand it the plan an agent produced and it flags reuse violations and dangerous targets up front.

```bash
sensei validate-plan plan.md                      # check a plan file (warn-only)
cat plan.md | sensei validate-plan --stdin        # pipe a plan straight in
sensei validate-plan plan.md --block              # exit non-zero on any finding
sensei validate-plan plan.md --json               # machine-readable output
```

| Finding | Meaning |
|---|---|
| **reuse-candidate** | The plan proposes creating a file/symbol whose name echoes existing code. Extend it instead of creating new. |
| **dangerous-target** | The plan proposes touching a file under a `dangerous.paths` glob, a high-fan-in file, or an entrypoint — even if that file does not exist yet. |

The plan is parsed with a hybrid reader: explicit `## Files` / `## New Symbols` sections when present, plus a heuristic fallback over prose. The JSON form is written to `.sensei/last-plan-validation.json`.

## How it works

1. **`scan`** walks the repo (respecting `.gitignore`), parses TS/JS with the raw `typescript` compiler API (error-tolerant, no type-checker), and indexes symbols + the import graph into `.sensei/cache.db` (SQLite + FTS5). Git metadata is collected in a single `git log` pass; re-scans are incremental via per-file content hashing.
2. **`context`** tokenizes your task, retrieves candidate symbols via FTS5, and scores them with a deterministic heuristic (name/signature overlap, path/domain match, exported, git-recency, tests-nearby). It also flags high-fan-in "do not touch" files from the import graph.
3. **`validate-diff`** resolves changed files (staged / working-tree / vs a ref), extracts the symbols each change *introduces*, and scores them against the index with a purpose-built token-Jaccard similarity (½ name + ½ signature). Dangerous edits come from the same fan-in analysis as `context`.
4. **`validate-plan`** parses an agent's plan into proposed files/symbols (structured sections + heuristic fallback) and runs the same reuse + dangerous checks against the index, using name-containment since a plan has no signatures yet. Dangerous targets also match `dangerous.paths` globs, so proposed *new* files are caught before they exist.
5. **`export`** renders the latest report for an AI agent. **`guard`** installs the git hook.

No API key. No network. Deterministic.

## MCP server

Run Sensei as a Model Context Protocol server so an AI agent can pull reuse
context itself:

```bash
sensei mcp
```

It serves two tools over stdio:

- `find_reuse({ task })` — reuse candidates and high-impact files for a task (runs an incremental scan first, returns markdown).
- `scan()` — rebuild the local index on demand.

Register it with an MCP client (cwd = your repo root). Example (Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "sensei": { "command": "sensei", "args": ["mcp"] }
  }
}
```

## Languages

Sensei extracts reuse candidates from:

| Language | Parser | Reuse detection | Dangerous-by-fan-in |
|----------|--------|-----------------|---------------------|
| TypeScript / JavaScript | `typescript` compiler | ✅ | ✅ |
| Python, Go, Rust, Java | Tree-sitter | ✅ | ❌ (use `dangerous.paths`) |

For the Tree-sitter languages, `validate-diff`/`validate-plan` detect duplicate symbols and flag files matched by `dangerous.paths`. High-fan-in ("do not touch") detection currently applies to TS/JS only, because it depends on the import graph.

**Upgrading:** existing repos with a written `.sensei/sensei.config.json` keep their `include` globs. To index the new languages, add the patterns you need (e.g. `"**/*.py"`, `"**/*.go"`, `"**/*.rs"`, `"**/*.java"`) and re-run `sensei scan`. A fresh `sensei init` includes them by default.

## Configuration

`.sensei/sensei.config.json` controls:

- include / ignore globs
- `context.topN` (how many reuse candidates to surface)
- scoring weights
- dangerous-file `importerThreshold` and `dangerous.paths` (gitignore-style globs flagged by `validate-plan`/`validate-diff`)
- `validate` block: `duplicateThreshold` (default `0.7`), `block`, `checkDuplicates`, `checkDangerous`

## Development

```bash
npm test         # run the vitest suite (101 tests)
npm run typecheck
npm run build
```

## Versioning

This repo follows [Semantic Versioning](https://semver.org/). See [CHANGELOG.md](./CHANGELOG.md) for the full history.

- **`0.1.0`** — MVP: `init`, `scan`, `context`, `export`.
- **`0.2.0`** — Enforcement: `validate-diff`, `guard`.
- **`0.3.0`** — Live scan TUI + batched git scan performance.
- **`0.4.0`** — `validate-plan`: agent plan validation before code.
- **`0.5.0`** — shell autocomplete (`zsh`, `bash`, `powershell`).
- **`0.6.0`** — GitHub Action: gate pull requests in CI.
- **`0.7.0`** — multi-language support via Tree-sitter (Python, Go, Rust, Java).
- **`0.8.0`** — Cursor/Codex export targets + `--write` managed-section injection.
- **`0.9.0`** — MCP server (`sensei mcp`): serve reuse context over stdio.

Pre-`1.0.0`: the CLI surface and config schema may still change between minor versions.

## GitHub Action

Gate pull requests with Sensei. The action scans your repo and checks the PR's
changed files for code-reuse violations and dangerous edits.

```yaml
# .github/workflows/sensei.yml
name: Sensei
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  sensei:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # required: validate-diff needs the merge-base
      - uses: deneuv34/sensei@v1
        with:
          block: true # fail the check on findings (omit for warn-only)
```

`fetch-depth: 0` is required so the action can compute the diff against the base branch.

### Inputs

| input | default | description |
|-------|---------|-------------|
| `version` | `latest` | Sensei npm version to run. Pin (e.g. `1.2.3`) for reproducible runs. |
| `base` | _(auto)_ | Diff base ref. Auto-resolves from the event when empty. |
| `block` | `false` | Fail the check when findings exist. Warn-only by default. |
| `working-directory` | `.` | Directory to run in (for monorepos). |
| `node-version` | `24` | Node.js version. |

### Outputs

| output | description |
|--------|-------------|
| `blocked` | `"true"` if blocking findings gated the check. |
| `findings` | Number of findings in the report. |
| `report-path` | Path to `.sensei/last-validation.json`. |

## Roadmap

Shipped: `init` · `scan` · `context` · `export` (claude/cursor/codex + `--write`) · `validate-diff` · `validate-plan` · `guard` · GitHub Action · MCP server (`sensei mcp`).

Multi-language: TypeScript/JavaScript (TypeScript compiler) · Python, Go, Rust, Java (Tree-sitter).

Planned: embeddings-based semantic retrieval. See the [full roadmap](docs/superpowers/specs/2026-06-20-sensei-roadmap.md) for what's next.

## License

MIT
