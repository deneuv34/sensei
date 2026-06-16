# Sensei — GitHub Action Design (Delivery, Phase 2.3)

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Builds on:** `docs/superpowers/specs/2026-06-16-sensei-validate-diff-design.md` (enforcement engine) and `docs/superpowers/specs/2026-06-16-sensei-design.md` (MVP). Assumes the published npm package `@deneuv34/sensei` exposes the `scan` and `validate-diff` commands (shipped in 0.4.0+).

**PRD alignment:** Implements the "GitHub Action" roadmap item (PRD Roadmap Phase 2 — "pre-commit/pre-push + GitHub Action"). Gives the enforcement trio (`guard` / `validate-plan` / `validate-diff`) a CI delivery surface so reuse and dangerous-edit findings gate real pull requests.

---

## 1. Summary

The enforcement commands run locally and in hooks today, but have no continuous-integration surface. This phase packages the existing CLI as a **reusable GitHub composite Action** so any repo can gate pull requests with one line:

```yaml
- uses: deneuv34/sensei@v1
  with:
    block: true
```

No new TypeScript source. The Action is pure packaging over the already-published CLI: it runs `sensei scan` to build the index, then `sensei validate-diff --against <base>` to check the PR's changed files, and maps the CLI exit code to the check status.

**Scope decisions (locked during brainstorming):**

- **Deliverable shape:** a reusable composite Action (`action.yml`) referenced as `uses: deneuv34/sensei@v1`. Not a copy-paste workflow template; not a Docker action.
- **Findings surface:** exit-code gate only. The check goes red when blocking findings exist; findings are visible in the job log. No PR comments, no inline annotations in v1 (deferred — see §8).
- **Default gating:** warn by default (`block: false`). Gating is opt-in via the `block` input so first adoption never surprise-breaks PRs.
- **Run mechanism:** `npx @deneuv34/sensei@<version>` (published package), not a bundled `dist/` and not a container image.

---

## 2. Architecture & Layout

New / changed files:

```
action.yml                      # composite action: inputs, steps, outputs (NEW)
.github/workflows/sensei.yml    # dogfood: run the action on this repo's own PRs/pushes (NEW)
README.md                       # "GitHub Action" usage section (CHANGED)
CHANGELOG.md                    # 0.x.0 entry (CHANGED, at release time)
```

`action.yml` uses `runs.using: composite`. Steps, in order:

1. **Setup Node** — `actions/setup-node@v4` with `node-version` input (default `24`) and npm cache.
2. **Resolve base ref** — compute the diff base (see §4) into a step output.
3. **Fetch base ref** — `git fetch --no-tags origin +refs/heads/<base>:refs/remotes/origin/<base>` so `validate-diff --against origin/<base>` has the ref as a tracked branch. PR checkouts do not include the base branch by default, so it must be fetched explicitly.

   **Prerequisite:** `validate-diff` diffs `origin/<base>...HEAD` (three-dot — merge-base to HEAD), so the **merge-base must exist in local history**. Consumers must check out with `actions/checkout@v4` and `fetch-depth: 0` (full history). The Action documents this and fails with a clear message if the merge-base is unreachable (exit `2`).
4. **Scan** — `npx @deneuv34/sensei@<version> scan` (builds `.sensei/cache.db` from defaults; no `init` required).
5. **Validate** — `npx @deneuv34/sensei@<version> validate-diff --against origin/<base> [--block] --json`, tee'd to the log and captured for output parsing.
6. **Emit outputs** — parse the JSON report into `blocked` / `findings` / `report-path` step outputs (§3).

The CLI's own exit code drives the step result; no extra gating logic in YAML (§5).

All steps honour `working-directory` (default `.`) for monorepo subdirectories.

---

## 3. Inputs & Outputs Contract

**Inputs** (`action.yml` `inputs:`):

| input | default | purpose |
|-------|---------|---------|
| `version` | `latest` | sensei npm version: `npx @deneuv34/sensei@<version>` |
| `base` | `''` (empty) | diff base ref; empty → auto-resolve (§4) |
| `block` | `false` | pass `--block` so blocking findings fail the check |
| `working-directory` | `.` | run directory (monorepo subdir) |
| `node-version` | `24` | `actions/setup-node` version |

**Outputs** (`action.yml` `outputs:`):

| output | source |
|--------|--------|
| `blocked` | report `.blocked` (`"true"`/`"false"`) |
| `findings` | `report.findings.length` (integer as string) |
| `report-path` | path to `.sensei/last-validation.json`, relative to `working-directory` |

Outputs are produced by a composite step that reads the captured `--json` report with `node -p` (already a dependency of the runner — avoids requiring `jq`). Downstream workflow steps consume `steps.<id>.outputs.blocked` etc.

The `ValidationReport` shape consumed here is the existing one written by `runValidateDiff`: `{ source, generatedAt, findings[], blocked }`.

---

## 4. Base Ref Resolution

When the `base` input is empty, resolve by event type:

- **`pull_request`** → `github.event.pull_request.base.ref` (e.g. `main`).
- **`push`** → `github.event.before` (previous tip of the pushed branch).
- **fallback** (other events / missing data) → repository default branch (`github.event.repository.default_branch`).

The resolved ref is fetched as `origin/<ref>` (step 3) and passed to `validate-diff --against origin/<ref>`. When `base` is set explicitly, it is used verbatim (still fetched first).

---

## 5. Exit Codes & Error Handling

CLI exit code → Action step outcome:

| exit | meaning | step result |
|------|---------|-------------|
| `0` | no findings, or warn-mode findings | **pass** |
| `1` | `validate-diff` blocked (only possible with `block: true`) | **fail** (the intended gate) |
| `2` | CLI error (no index, bad ref, read failure) | **fail** (distinct from gate; message in log) |

The composite Action lets the CLI's non-zero exit propagate to fail the step; it does not swallow exit `2` into a false "blocked". The `--json` capture for outputs runs only on the success path; on exit `2` the step fails before outputs are emitted, which is correct (no report to parse).

**Edge cases:**

- **Consumer repo has no `.sensei/` config** → `scan` uses built-in defaults and still produces an index. No `sensei init` step required.
- **Shallow checkout** (`fetch-depth: 1`) → the three-dot merge-base may be unreachable, so `validate-diff` errors (exit `2`). The Action requires consumers to check out with `fetch-depth: 0`; the README example and the dogfood workflow both set it. If the base fetch itself fails (e.g. base branch deleted), the step errors with a clear message (exit `2`).
- **No changed files vs base** → empty findings → pass.
- **Fork PRs** → gate-only means a read-only `GITHUB_TOKEN` is sufficient; no `pull-requests: write`, no secrets. Fork PRs are not blocked by missing write permission.
- **`working-directory` set** → every step runs there; `report-path` is resolved relative to it.

---

## 6. Permissions & Security

- Default `permissions: contents: read` is sufficient (gate-only; no PR writes).
- No secrets required. The Action runs the published, provenance-signed npm package (publish path uses npm trusted publishing / OIDC per `publish.yml`).
- `version` should be pinnable by consumers (`@1.2.3`) for supply-chain hygiene; `latest` is the convenience default.
- The Action executes third-party code only via the explicitly versioned `@deneuv34/sensei` package and pinned `actions/setup-node@v4`.

---

## 7. Testing Strategy

- **Dogfood workflow** (`.github/workflows/sensei.yml`) runs the Action on Sensei's own pull requests and pushes to `main`. Configured warn-mode (`block: false`) so it never blocks our own development. This is the primary integration test — it exercises base resolution, fetch, scan, validate, and output emission on every PR.
- **`actionlint`** step added to the existing `ci.yml` to lint `action.yml` and workflow YAML/shell for syntax and shell-quoting errors.
- **Manual verification:** open a throwaway PR that introduces a symbol duplicating existing code; confirm the finding appears in the log, and that with `block: true` the check goes red. Confirm a clean PR stays green.
- No new Vitest suites — the Action adds no TypeScript source.

---

## 8. Out of Scope (deferred)

- **Inline annotations** (`::warning file=...,line=...::` on the diff) — deferred; requires confirming `Finding` carries reliable file+line for the *introduced* symbol.
- **Sticky PR comment** with a findings table — deferred; needs `pull-requests: write` and comment dedup logic.
- **`validate-plan` in CI** — no natural plan-file artifact in a standard PR; out of scope for this Action.
- **GitHub Marketplace listing** — the Action is usable by `uses: deneuv34/sensei@v1` without a Marketplace listing. Listing (branding, release publish step) is optional polish, not required for this phase.
- **Index caching across runs** (`actions/cache` on `.sensei/cache.db`) — possible follow-up perf optimization; v1 scans fresh each run for correctness.

---

## 9. Release & Versioning

- The Action ships with the package release that documents it (a `0.x.0` minor bump + CHANGELOG entry).
- Consumers reference a major tag (`v1`). A moving `v1` tag is maintained alongside exact `vX.Y.Z` tags so `uses: deneuv34/sensei@v1` tracks the latest compatible release.
- README gains a "GitHub Action" usage section with the minimal example and the full input table.
