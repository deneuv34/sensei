# Cursor/Codex Exporters & Embeddings-Based Retrieval — Design

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan
**Phase:** Roadmap — final two planned items (`export` targets + semantic retrieval)
**Scope:** Two independent features shipped as the next roadmap batch:
1. **Cursor/Codex exporters** — render the existing `ContextReport` for the Cursor and Codex agents, with an optional `--write` that injects a managed section into each tool's native rule file.
2. **Embeddings-based retrieval** — add local, offline vector similarity as a new signal in reuse-candidate ranking, surfacing symbols that lexical FTS misses.

They share no state and ship in order (exporters first). Each gets its own implementation plan.

---

## 1. Goals & Non-Goals

### Goals
- `sensei export --target cursor|codex` produces tool-appropriate output, and `--write` drops it into the tool's native auto-loaded rule file without destroying existing user content.
- `sensei context "<task>"` surfaces reuse candidates whose **meaning** matches the task even when no lexical token overlaps (query "login" finds `authenticate`), while preserving every existing reuse-trust signal (recency, exported, tests, fan-in).
- Embeddings work **offline, with no API key**, both locally and in the GitHub Action / CI.

### Non-Goals
- **No API/remote embedding provider.** Local ONNX model only. A pluggable provider layer is deliberately deferred (YAGNI) until someone needs it.
- **No ANN index** (`sqlite-vec`, `hnswlib`). Brute-force cosine until corpus size proves it slow; upgrade path documented in code.
- **No new `export` targets** beyond cursor/codex.
- **No re-ranking model / cross-encoder.** Cosine similarity is the only semantic signal.
- **No embedding of arbitrary files** — only indexed symbols (`name + signature + jsdoc`).

---

## 2. Key Decisions (from brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| Exporter output | Render blob to stdout **and** `--write` to native file | stdout for piping; native file for the tool's auto-load. Same renderer feeds both. |
| `--write` safety | **Managed section** between `<!-- SENSEI:START --> … <!-- SENSEI:END -->` markers | `AGENTS.md` / `.cursor/rules` often hold user content; never clobber it. Idempotent on re-run. |
| Embedding provider | **Local ONNX**, `@xenova/transformers`, `Xenova/all-MiniLM-L6-v2` (384-dim) | A scanner that demands an API key kills adoption and breaks offline CI. One implementation, no provider plugin layer. |
| Vector storage/search | **Brute-force cosine** over BLOB vectors in SQLite | Dev repos rarely exceed ~20k symbols (<50ms); zero new native deps, no cross-platform packaging risk. |
| Lexical + semantic fusion | **Union candidate sets, one added weighted scorer term** | Sensei ranks reuse-worthiness, not pure relevance; semantic similarity is one input among several. Preserves determinism, reasons, and all existing signals. |
| Degradation | Model load failure → lexical-only with a warning | First offline run without cached weights, or a CI without network, must not crash `scan`/`context`. |

---

## 3. Feature 1 — Cursor/Codex Exporters

### 3.1 Files
| File | Change |
|------|--------|
| `src/exporters/cursor.ts` | **new** — `renderCursor(report): string` |
| `src/exporters/codex.ts` | **new** — `renderCodex(report): string` |
| `src/exporters/write-section.ts` | **new** — managed-section inject helper |
| `src/core/run-export.ts` | wire cursor/codex dispatch; add `--write` handling |
| `src/commands/export.ts` | add `--write` flag |
| `test/exporter.test.ts` | extend |

### 3.2 Renderers
Same `ContextReport` input as `renderClaude`. Cursor/Codex emit **markdown** (idiomatic for `.md`/`.mdc`), unlike claude's plaintext `=== SENSEI CONTEXT ===` block. Body sections identical in content: reuse candidates, dangerous files, agent rules.

- `renderCursor` → MDC: frontmatter then markdown body.
  ```
  ---
  description: Sensei reuse/danger context for the current task
  globs: "**/*"
  alwaysApply: true
  ---
  ## Reuse these (do not reimplement)
  ...
  ```
- `renderCodex` → plain markdown body, no frontmatter (Codex `AGENTS.md` is plain markdown).

A shared private helper builds the three body sections once; each renderer wraps it (claude keeps its plaintext wrapper, cursor/codex use markdown headings). No behavior change to `renderClaude`.

### 3.3 `--write` (managed section)
| Target | Native path |
|--------|-------------|
| cursor | `.cursor/rules/sensei.mdc` |
| codex  | `AGENTS.md` |

`writeManagedSection(filePath, body)`:
1. Wrap body in `<!-- SENSEI:START -->\n{body}\n<!-- SENSEI:END -->`.
2. File absent → `mkdir -p` parent, write block.
3. File present, markers found → regex-replace the block in place, preserve everything else.
4. File present, no markers → append block (one blank line separator).

Idempotent: re-running replaces the same block. `claude` target with `--write` is **not** supported initially (no canonical native file) → error directs to stdout. Without `--write`, behavior is unchanged: print to stdout, no disk touch.

### 3.4 Tests
- Snapshot `renderCursor` / `renderCodex` for a fixture report (with and without candidates).
- `writeManagedSection`: create-when-absent, replace-in-place, preserve-surrounding-content, idempotent re-run, append-when-no-markers.

---

## 4. Feature 2 — Embeddings-Based Retrieval

### 4.1 Dependency & model
- Add `@xenova/transformers`.
- Model `Xenova/all-MiniLM-L6-v2`, 384-dim, cached under `.sensei/models/` (already covered by the `.sensei/` gitignore).
- First run fetches the model; subsequent runs are offline from cache.

### 4.2 Schema (`src/indexer/db.ts`)
```sql
CREATE TABLE IF NOT EXISTS embeddings (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  vec BLOB NOT NULL          -- 384 × float32, little-endian
);
```
- `meta` key `embedding_model` records the model id. If it differs from the current model on `scan`, all embeddings are rebuilt (model change invalidates vectors).
- `ON DELETE CASCADE` — embeddings drop with their symbol; `clearFileEntities` already deletes symbols per file, so per-file re-embed falls out naturally once cascade is relied on (verify cascade fires for the manual symbol deletes; if not, delete embeddings explicitly alongside).
- New `IndexDb` methods: `insertEmbedding(symbolId, Float32Array)`, `allEmbeddings(): {symbol_id, vec}[]` (returns decoded `Float32Array`), `countEmbeddings()`.

### 4.3 Model module (`src/embed/model.ts`)
Async-warmup singleton mirroring `src/ast/treesitter/runtime.ts`:
- `embed(texts: string[]): Promise<Float32Array[]>` — mean-pooled, L2-normalized sentence embeddings.
- Load failure throws typed `EmbeddingsUnavailable` (caught by callers for degradation).
- Lazy: model loads on first `embed`, reused after.

### 4.4 Scan path (`src/core/run-scan.ts`, `src/indexer/index-repo.ts`)
- For each symbol of a **changed** file (existing hash gate), embed `name + " " + signature + " " + jsdoc`.
- Batch embed per file, `insertEmbedding` per symbol.
- Incremental: unchanged files keep existing vectors.
- Model unavailable at scan → catch `EmbeddingsUnavailable`, warn once, build FTS only, leave `embeddings` empty. Scan still succeeds.
- Embedding work runs after symbol insert (needs `symbol_id`).

### 4.5 Context path (`src/core/run-context.ts`, new `src/search/vector.ts`)
1. FTS candidates — existing `searchSymbols`.
2. If `countEmbeddings() > 0`: embed query text → `vectorSearch(db, queryVec, k)` = brute-force cosine over `allEmbeddings()`, return top-K `symbol_id` + cosine.
   `// ponytail: brute-force cosine over all vectors; swap to sqlite-vec/hnsw above ~50k symbols`
3. **Union** FTS hit symbol_ids ∪ vector top-K symbol_ids → hydrate full `SymbolHitRow`s for any vector-only ids (new `IndexDb.symbolsByIds`).
4. Pass a `Map<symbol_id, cosine>` into `scoreCandidates`.
5. Embeddings empty/unavailable → step 2-4 skipped, lexical-only, warn once. No crash.

### 4.6 Scorer (`src/scorer/score.ts`)
- New param `semanticSim?: Map<number, number>` (symbol_id → cosine).
- If present and `cosine > 0`: `score += w.semanticSim * cosine`; push reason `"semantically similar to task"`.
- Final clamp `[0,1]` and tie-break (score → path → name) unchanged → determinism preserved.

### 4.7 Config (`src/config/schema.ts`)
- Add `scoring.semanticSim: number` with a sensible default (tuned so semantic and `nameOverlap` are comparable in magnitude).
- Add `context.vectorTopK: number` (default e.g. 50) — vector recall breadth before fusion.

### 4.8 Tests
- `vectorSearch` cosine ordering on hand-built vectors (known top-K).
- BLOB round-trip: `Float32Array` → store → `allEmbeddings` → identical floats.
- Union dedup: symbol in both FTS and vector sets appears once.
- Scorer with `semanticSim` map: term applied, reason present, clamp/tie-break hold.
- **Graceful fallback:** `embed` mocked to throw `EmbeddingsUnavailable` → `scan` builds FTS and succeeds; `context` returns lexical-only ranking without throwing.

---

## 5. Sequencing
1. **Exporters** — no new deps, ~3 small files + wiring. Ship and release first.
2. **Embeddings** — adds `@xenova/transformers`, schema migration, scan/context/scorer changes. Ship second.

Each feature: its own implementation plan, its own PR, its own minor release.
