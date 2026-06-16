# Sensei GitHub Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reusable GitHub composite Action that gates pull requests by running the published `@deneuv34/sensei` CLI (`scan` then `validate-diff --against <base>`) and mapping its exit code to the check status.

**Architecture:** Pure packaging over the already-published npm CLI. A `runs.using: composite` `action.yml` sets up Node, resolves and fetches the diff base, runs `npx @deneuv34/sensei@<version> scan` then `validate-diff`, and emits outputs parsed from the report file the CLI always writes (`.sensei/last-validation.json`). No new TypeScript source.

**Tech Stack:** GitHub Actions composite action (YAML + bash), `actions/setup-node@v4`, the published `@deneuv34/sensei` npm package, `actionlint` for static validation, `node -p` for JSON parsing (no `jq`).

**Spec:** `docs/superpowers/specs/2026-06-16-sensei-github-action-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `action.yml` (create) | The composite Action: inputs, steps (setup/resolve/fetch/scan/validate/outputs), outputs. |
| `.github/workflows/sensei.yml` (create) | Dogfood workflow: runs the local action on this repo's PRs/pushes in warn mode. Primary integration test. |
| `.github/workflows/ci.yml` (modify) | Add an `actionlint` job that statically lints `action.yml` and workflow YAML. |
| `README.md` (modify) | Add a "GitHub Action" usage section (minimal example + input/output tables); update Roadmap line. |
| `CHANGELOG.md` (modify) | Add an `Unreleased` → Added entry for the Action. |

No source or test directories are touched.

---

## Pre-flight

- [ ] **Step 0: Install `actionlint` locally for verification**

Run:
```bash
cd /Users/deneuv34/Working/personal/sensei
ACTIONLINT_VERSION=1.7.7
curl -fsSL -o /tmp/actionlint.tar.gz \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_$(uname -s | tr '[:upper:]' '[:lower:]')_$( [ "$(uname -m)" = "arm64" ] && echo arm64 || echo amd64 ).tar.gz"
tar -C /tmp -xzf /tmp/actionlint.tar.gz actionlint
/tmp/actionlint -version
```
Expected: prints a version like `1.7.7`. If the download fails (offline), skip local lint and rely on the CI `actionlint` job (Task 3) for validation.

---

## Task 1: Composite Action (`action.yml`)

**Files:**
- Create: `action.yml`

- [ ] **Step 1: Write `action.yml`**

```yaml
name: Sensei
description: Check a pull request's changed files against the Sensei index for code-reuse violations and dangerous edits.
author: deneuv34
branding:
  icon: shield
  color: purple

inputs:
  version:
    description: 'Sensei npm version to run (e.g. "1.2.3" or "latest").'
    required: false
    default: latest
  base:
    description: 'Diff base ref. Empty auto-resolves from the event (PR base / push before / default branch).'
    required: false
    default: ''
  block:
    description: 'Fail the check when blocking findings exist.'
    required: false
    default: 'false'
  working-directory:
    description: 'Directory to run in (for monorepos).'
    required: false
    default: '.'
  node-version:
    description: 'Node.js version for actions/setup-node.'
    required: false
    default: '24'

outputs:
  blocked:
    description: '"true" if blocking findings gated the check, else "false".'
    value: ${{ steps.validate.outputs.blocked }}
  findings:
    description: 'Number of findings in the report.'
    value: ${{ steps.validate.outputs.findings }}
  report-path:
    description: 'Path to the JSON validation report, relative to working-directory.'
    value: ${{ steps.validate.outputs.report-path }}

runs:
  using: composite
  steps:
    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}

    - name: Resolve base ref
      id: base
      shell: bash
      env:
        INPUT_BASE: ${{ inputs.base }}
        EVENT_NAME: ${{ github.event_name }}
        PR_BASE: ${{ github.event.pull_request.base.ref }}
        PUSH_BEFORE: ${{ github.event.before }}
        DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
      run: |
        base="$INPUT_BASE"
        if [ -z "$base" ]; then
          case "$EVENT_NAME" in
            pull_request|pull_request_target) base="$PR_BASE" ;;
            push) base="$PUSH_BEFORE" ;;
            *) base="$DEFAULT_BRANCH" ;;
          esac
        fi
        if [ -z "$base" ]; then
          echo "Could not resolve a diff base ref. Pass the 'base' input explicitly." >&2
          exit 1
        fi
        echo "ref=$base" >> "$GITHUB_OUTPUT"

    - name: Fetch base ref
      shell: bash
      working-directory: ${{ inputs.working-directory }}
      env:
        BASE: ${{ steps.base.outputs.ref }}
      run: |
        if git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
          echo "Base '${BASE}' already present in local history."
        else
          git fetch --no-tags origin "+refs/heads/${BASE}:refs/remotes/origin/${BASE}"
        fi

    - name: Scan
      shell: bash
      working-directory: ${{ inputs.working-directory }}
      env:
        VERSION: ${{ inputs.version }}
      run: npx --yes "@deneuv34/sensei@${VERSION}" scan

    - name: Validate diff
      id: validate
      shell: bash
      working-directory: ${{ inputs.working-directory }}
      env:
        VERSION: ${{ inputs.version }}
        BASE: ${{ steps.base.outputs.ref }}
        BLOCK: ${{ inputs.block }}
      run: |
        if git rev-parse --verify --quiet "refs/remotes/origin/${BASE}" >/dev/null; then
          against="origin/${BASE}"
        else
          against="${BASE}"
        fi
        blockflag=""
        if [ "$BLOCK" = "true" ]; then blockflag="--block"; fi
        set +e
        npx --yes "@deneuv34/sensei@${VERSION}" validate-diff --against "$against" $blockflag
        code=$?
        set -e
        report=".sensei/last-validation.json"
        if [ -f "$report" ]; then
          blocked=$(node -p "try{String(require('./.sensei/last-validation.json').blocked)}catch(e){''}")
          findings=$(node -p "try{require('./.sensei/last-validation.json').findings.length}catch(e){''}")
          echo "blocked=$blocked" >> "$GITHUB_OUTPUT"
          echo "findings=$findings" >> "$GITHUB_OUTPUT"
          echo "report-path=$report" >> "$GITHUB_OUTPUT"
        fi
        exit $code
```

- [ ] **Step 2: Lint `action.yml`**

Run:
```bash
/tmp/actionlint action.yml
```
Expected: no output, exit 0. (If `actionlint` was not installed in Step 0, skip — Task 3's CI job will catch errors.)

Note: `actionlint` runs `shellcheck` on `run:` blocks when `shellcheck` is present; passing `shellcheck` validation here means the bash is quoting-safe. The `$blockflag` is intentionally unquoted (word-splitting to either an empty arg or `--block`); if `shellcheck` flags SC2086 on that line, it is acceptable and expected for this flag-toggle pattern.

- [ ] **Step 3: Commit**

```bash
git add action.yml
git commit -m "feat(action): composite GitHub Action over sensei validate-diff"
```

---

## Task 2: Dogfood Workflow (`.github/workflows/sensei.yml`)

**Files:**
- Create: `.github/workflows/sensei.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Sensei

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  sensei:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history so validate-diff can find the merge-base
      - uses: ./
        with:
          block: false # warn-only: never block our own development
```

Note: `uses: ./` runs the composite action from the checked-out repo (this `action.yml`), so the workflow tests the real Action wiring on every PR/push.

- [ ] **Step 2: Lint the workflow**

Run:
```bash
/tmp/actionlint .github/workflows/sensei.yml
```
Expected: no output, exit 0. (Skip if `actionlint` unavailable.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sensei.yml
git commit -m "ci: dogfood the Sensei action on our own PRs (warn mode)"
```

---

## Task 3: actionlint Job in CI (`.github/workflows/ci.yml`)

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a `lint-actions` job**

Append this job under `jobs:` in `.github/workflows/ci.yml` (after the existing `test` job, same indentation level as `test:`):

```yaml
  lint-actions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run actionlint
        shell: bash
        env:
          ACTIONLINT_VERSION: 1.7.7
        run: |
          curl -fsSL -o actionlint.tar.gz \
            "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
          tar -xzf actionlint.tar.gz actionlint
          ./actionlint -color
```

The resulting file must read (full content):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test

  lint-actions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run actionlint
        shell: bash
        env:
          ACTIONLINT_VERSION: 1.7.7
        run: |
          curl -fsSL -o actionlint.tar.gz \
            "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
          tar -xzf actionlint.tar.gz actionlint
          ./actionlint -color
```

- [ ] **Step 2: Lint the modified CI workflow**

Run:
```bash
/tmp/actionlint .github/workflows/ci.yml
```
Expected: no output, exit 0. (Skip if `actionlint` unavailable.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint actions with actionlint"
```

---

## Task 4: README "GitHub Action" Section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the usage section**

Insert a new `## GitHub Action` section immediately before the `## Roadmap` section (line ~166). Content:

````markdown
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
````

- [ ] **Step 2: Update the Roadmap line**

In `README.md`, find the Roadmap "Shipped"/"Planned" lines:
```markdown
Shipped: `init` · `scan` · `context` · `export` · `validate-diff` · `validate-plan` · `guard`.

Planned: a GitHub Action, embeddings-based retrieval, multi-language support, and Cursor/Codex exporters.
```
Replace with:
```markdown
Shipped: `init` · `scan` · `context` · `export` · `validate-diff` · `validate-plan` · `guard` · GitHub Action.

Planned: embeddings-based retrieval, multi-language support, and Cursor/Codex exporters.
```

- [ ] **Step 3: Verify Markdown renders (visual scan)**

Run:
```bash
git --no-pager diff README.md | head -80
```
Expected: the new `## GitHub Action` section and the updated Roadmap lines appear; no stray fences or broken tables.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the Sensei GitHub Action"
```

---

## Task 5: Changelog Entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an Unreleased entry**

Insert at the top of `CHANGELOG.md`, immediately after the intro paragraph (before `## [0.5.0]`):

```markdown
## [Unreleased]

### Added

- **GitHub Action** — a reusable composite action (`uses: deneuv34/sensei@v1`) that runs `sensei scan` then `validate-diff --against <base>` to gate pull requests. Warn-only by default; set `block: true` to fail the check on findings. Requires `actions/checkout` with `fetch-depth: 0`. Inputs: `version`, `base`, `block`, `working-directory`, `node-version`. Outputs: `blocked`, `findings`, `report-path`.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for GitHub Action"
```

---

## Final Verification (manual, on GitHub)

These cannot run locally — they validate the Action end-to-end on GitHub's runners. Perform after the branch is pushed and a PR is open.

- [ ] **Step 1: Confirm the dogfood job runs green on the PR**

On the PR for this work, confirm the **Sensei** workflow runs: it sets up Node, resolves base `main`, fetches it, scans, validates, and (warn mode) finishes green. Check the job log shows the findings table.

- [ ] **Step 2: Confirm the gate fires (throwaway test)**

Open a throwaway branch/PR that copies an existing exported function into a new file (a duplicate), with a temporary workflow using `block: true`. Confirm the **Sensei** check goes red and the log names the duplicate finding. Discard the throwaway branch.

- [ ] **Step 3: Confirm `actionlint` CI job passes**

Confirm the `lint-actions` job in **CI** passes on the PR.

---

## Release (separate, after merge)

Versioning and tagging are handled by the project's existing release flow (see `publish.yml` and prior releases), not by this plan. At release time: bump `package.json`, move the `Unreleased` changelog entry under the new version, tag `vX.Y.Z`, and create/move the `v1` major tag so `uses: deneuv34/sensei@v1` resolves. Marketplace listing is optional (spec §8).

---

## Self-Review Notes

- **Spec coverage:** §2 layout → Tasks 1–5; §3 inputs/outputs → Task 1 (`inputs`/`outputs`) + README Task 4; §4 base resolution → Task 1 "Resolve base ref" step; §5 exit codes → Task 1 validate step (`exit $code` propagation); §6 permissions → dogfood `permissions: contents: read` (Task 2) + README example; §7 testing → Tasks 2 (dogfood) + 3 (actionlint) + Final Verification; §8 out-of-scope → not implemented (correct); §9 release → "Release" section.
- **`fetch-depth: 0`** requirement (spec §2 prerequisite, §5) is enforced in the dogfood workflow (Task 2) and documented in the README example (Task 4).
- **No placeholders**: every file's full content is shown.
- **Name consistency**: step id `validate` is referenced by `action.yml` `outputs.*.value`; report path string `.sensei/last-validation.json` is identical across Task 1 and README.
