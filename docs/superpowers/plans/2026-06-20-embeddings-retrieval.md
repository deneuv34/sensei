# Embeddings-Based Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local, offline vector similarity as a new signal in reuse-candidate ranking, so `sensei context "<task>"` surfaces symbols whose *meaning* matches the task even when no lexical token overlaps.

**Architecture:** A new `embeddings` table (one 384-float vector per symbol, stored as a BLOB) is populated during `scan` by a local ONNX model. The scan embedding pass runs in `run-scan.ts` **after** the synchronous index transaction commits (it cannot run inside `indexFiles`, which is a synchronous `better-sqlite3` transaction — `embed` is async). Incremental-ness is automatic: cascade deletes drop a symbol's embedding with the symbol, so "symbols with no embedding row" is exactly the set of new/changed symbols. `context` embeds the query, runs brute-force cosine over all stored vectors, unions the vector top-K with the FTS hits, and passes a `symbol_id → cosine` map into the scorer as one new weighted term. Determinism, existing signals, and graceful degradation (model unavailable → lexical-only with a warning) are all preserved.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `better-sqlite3`, `@xenova/transformers` (new dep, local ONNX), Zod config, Vitest.

## Global Constraints

- **Node `>=22`.** ESM only; every local import uses a `.js` specifier (e.g. `'../embed/model.js'`).
- **No network at query time, no API key.** Embeddings run from a locally-cached ONNX model. First `scan` may fetch the model once into `.sensei/models/`; every later run is offline from cache.
- **Deterministic.** Same repo + same task = same output. Cosine is the only semantic signal — no re-ranking model, no randomness. Tie-breaks stay `score desc → path asc → name asc`.
- **Never crash on missing embeddings.** Model load/inference failure throws `EmbeddingsUnavailable`; callers catch it, warn once, and fall back to lexical-only. `scan` and `context` must still succeed.
- **No new native deps.** Brute-force cosine over BLOB vectors in SQLite. No `sqlite-vec`, no `hnswlib`. Mark the upgrade point with a `ponytail:` comment.
- **Model:** `Xenova/all-MiniLM-L6-v2`, 384-dim, mean-pooled + L2-normalized. Embedded text per symbol is `` `${name} ${signature} ${jsdoc}` ``.
- **No model download in tests.** Unit/e2e tests mock `../src/embed/model.js`. The real model is never loaded in CI.
- **Backward compatible.** New config fields have defaults; the new scorer param is optional. Existing callers and indexes keep working (an old index simply has zero embeddings until the next `scan`).
- **Commit after every green task.** Conventional Commits (`feat:`, `test:`, `chore:`).

---

### Task 1: Config — semantic-sim weight + vector recall breadth

**Files:**
- Modify: `src/config/schema.ts:19-27` (scoring block), `src/config/schema.ts:16-18` (context block)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: existing `ConfigSchema` / `SenseiConfig`.
- Produces: `config.scoring.semanticSim: number` (default `0.25`), `config.context.vectorTopK: number` (default `50`). Relied on by Tasks 5, 6, 7.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.ts`:

```typescript
import { DEFAULT_CONFIG } from '../src/config/schema.js';

it('defaults the semantic-sim weight and vector recall breadth', () => {
  expect(DEFAULT_CONFIG.scoring.semanticSim).toBe(0.25);
  expect(DEFAULT_CONFIG.context.vectorTopK).toBe(50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — `expected undefined to be 0.25`.

- [ ] **Step 3: Add the fields**

In `src/config/schema.ts`, change the `context` block:

```typescript
  context: z
    .object({
      topN: z.number().int().positive().default(10),
      vectorTopK: z.number().int().positive().default(50),
    })
    .default({}),
```

And add `semanticSim` to the `scoring` block:

```typescript
  scoring: z
    .object({
      nameOverlap: z.number().default(0.4),
      pathMatch: z.number().default(0.2),
      exportedBoost: z.number().default(0.15),
      gitRecency: z.number().default(0.15),
      testExists: z.number().default(0.1),
      semanticSim: z.number().default(0.25),
    })
    .default({}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts test/config.test.ts
git commit -m "feat: add scoring.semanticSim and context.vectorTopK config"
```

---

### Task 2: DB — `embeddings` table + access methods

**Files:**
- Modify: `src/indexer/db.ts` (SCHEMA constant + new `IndexDb` methods)
- Test: `test/indexer-db.test.ts`

**Interfaces:**
- Consumes: existing `IndexDb`, `SymbolHitRow`.
- Produces (new `IndexDb` methods, relied on by Tasks 3, 6, 7):
  - `insertEmbedding(symbolId: number, vec: Float32Array): void`
  - `allEmbeddings(): Array<{ symbol_id: number; vec: Float32Array }>`
  - `countEmbeddings(): number`
  - `symbolsMissingEmbeddings(): Array<{ symbol_id: number; name: string; signature: string; jsdoc: string }>`
  - `symbolsByIds(ids: number[]): SymbolHitRow[]` (same row shape as `searchSymbols`)
  - `clearEmbeddings(): void`

- [ ] **Step 1: Write the failing test**

Add to `test/indexer-db.test.ts` (it already imports `IndexDb`):

```typescript
describe('embeddings storage', () => {
  function dbWithOneSymbol() {
    const db = new IndexDb(':memory:');
    db.migrate();
    const fileId = db.upsertFile({
      path: 'a.ts', hash: 'h', lang: 'ts', loc: 1,
      gitLastModified: null, gitCommitCount: 0,
    });
    db.insertSymbol(
      fileId,
      { kind: 'function', name: 'authenticate', signature: '()', exported: true, startLine: 1, jsdoc: 'log a user in' },
      'a.ts',
    );
    const { symbol_id } = db.symbolsMissingEmbeddings()[0];
    return { db, symbol_id };
  }

  it('round-trips a Float32Array through a BLOB', () => {
    const { db, symbol_id } = dbWithOneSymbol();
    const vec = Float32Array.from([0.5, -0.25, 0.125, 1]);
    db.insertEmbedding(symbol_id, vec);
    expect(db.countEmbeddings()).toBe(1);
    const all = db.allEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0].symbol_id).toBe(symbol_id);
    expect(Array.from(all[0].vec)).toEqual([0.5, -0.25, 0.125, 1]);
  });

  it('symbolsMissingEmbeddings returns only un-embedded symbols', () => {
    const { db, symbol_id } = dbWithOneSymbol();
    expect(db.symbolsMissingEmbeddings().map((s) => s.symbol_id)).toEqual([symbol_id]);
    db.insertEmbedding(symbol_id, Float32Array.from([1]));
    expect(db.symbolsMissingEmbeddings()).toEqual([]);
  });

  it('clearEmbeddings empties the table', () => {
    const { db, symbol_id } = dbWithOneSymbol();
    db.insertEmbedding(symbol_id, Float32Array.from([1]));
    db.clearEmbeddings();
    expect(db.countEmbeddings()).toBe(0);
  });

  it('symbolsByIds hydrates full hit rows', () => {
    const { db, symbol_id } = dbWithOneSymbol();
    const rows = db.symbolsByIds([symbol_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('authenticate');
    expect(rows[0].path).toBe('a.ts');
    expect(db.symbolsByIds([])).toEqual([]);
  });

  it('embeddings cascade-delete with their symbol', () => {
    const { db, symbol_id } = dbWithOneSymbol();
    db.insertEmbedding(symbol_id, Float32Array.from([1]));
    db.clearFileEntities(db.getFileByPath('a.ts')!.id);
    expect(db.countEmbeddings()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- indexer-db`
Expected: FAIL — `db.insertEmbedding is not a function`.

- [ ] **Step 3: Add the table to the SCHEMA constant**

In `src/indexer/db.ts`, inside the `SCHEMA` template string, add after the `meta` table line:

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  vec BLOB NOT NULL
);
```

- [ ] **Step 4: Add the methods**

In `src/indexer/db.ts`, add these methods to the `IndexDb` class (e.g. after `countSymbols`):

```typescript
  insertEmbedding(symbolId: number, vec: Float32Array): void {
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.raw
      .prepare('INSERT OR REPLACE INTO embeddings (symbol_id, vec) VALUES (?, ?)')
      .run(symbolId, blob);
  }

  allEmbeddings(): Array<{ symbol_id: number; vec: Float32Array }> {
    const rows = this.raw
      .prepare('SELECT symbol_id, vec FROM embeddings')
      .all() as Array<{ symbol_id: number; vec: Buffer }>;
    return rows.map((r) => {
      const copy = r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength);
      return { symbol_id: r.symbol_id, vec: new Float32Array(copy) };
    });
  }

  countEmbeddings(): number {
    return (this.raw.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
  }

  symbolsMissingEmbeddings(): Array<{ symbol_id: number; name: string; signature: string; jsdoc: string }> {
    return this.raw
      .prepare(
        `SELECT s.id AS symbol_id, s.name, s.signature, s.jsdoc
         FROM symbols s
         LEFT JOIN embeddings e ON e.symbol_id = s.id
         WHERE e.symbol_id IS NULL
         ORDER BY s.id`,
      )
      .all() as Array<{ symbol_id: number; name: string; signature: string; jsdoc: string }>;
  }

  symbolsByIds(ids: number[]): SymbolHitRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.raw
      .prepare(
        `SELECT s.id AS symbol_id, s.file_id, f.path, s.kind, s.name, s.signature,
                s.exported, s.start_line, s.jsdoc, f.git_last_modified
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.id IN (${placeholders})`,
      )
      .all(...ids) as SymbolHitRow[];
  }

  clearEmbeddings(): void {
    this.raw.exec('DELETE FROM embeddings');
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- indexer-db`
Expected: PASS (all 5 new cases; the cascade case confirms `foreign_keys = ON` does its job).

- [ ] **Step 6: Commit**

```bash
git add src/indexer/db.ts test/indexer-db.test.ts
git commit -m "feat: embeddings table and access methods on IndexDb"
```

---

### Task 3: Vector search (pure cosine top-K)

**Files:**
- Create: `src/search/vector.ts`
- Test: `test/vector.test.ts`

**Interfaces:**
- Consumes: `IndexDb.allEmbeddings()` (Task 2).
- Produces (relied on by Task 7):
  - `cosineTopK(query: Float32Array, rows: Array<{ symbol_id: number; vec: Float32Array }>, k: number): Array<{ symbol_id: number; score: number }>` — pure, deterministic.
  - `vectorSearch(db: IndexDb, query: Float32Array, k: number): Array<{ symbol_id: number; score: number }>` — thin DB wrapper.

- [ ] **Step 1: Write the failing test**

Create `test/vector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cosineTopK } from '../src/search/vector.js';

const rows = [
  { symbol_id: 1, vec: Float32Array.from([1, 0, 0]) },
  { symbol_id: 2, vec: Float32Array.from([0, 1, 0]) },
  { symbol_id: 3, vec: Float32Array.from([0.8, 0.6, 0]) },
];

describe('cosineTopK', () => {
  it('orders by cosine similarity descending', () => {
    const top = cosineTopK(Float32Array.from([1, 0, 0]), rows, 3);
    expect(top.map((t) => t.symbol_id)).toEqual([1, 3, 2]);
    expect(top[0].score).toBeCloseTo(1, 5);
    expect(top[2].score).toBeCloseTo(0, 5);
  });

  it('caps results at k', () => {
    expect(cosineTopK(Float32Array.from([1, 0, 0]), rows, 1).map((t) => t.symbol_id)).toEqual([1]);
  });

  it('breaks ties by symbol_id ascending', () => {
    const tied = [
      { symbol_id: 5, vec: Float32Array.from([1, 0, 0]) },
      { symbol_id: 2, vec: Float32Array.from([1, 0, 0]) },
    ];
    expect(cosineTopK(Float32Array.from([1, 0, 0]), tied, 2).map((t) => t.symbol_id)).toEqual([2, 5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- vector`
Expected: FAIL — cannot find module `../src/search/vector.js`.

- [ ] **Step 3: Write the implementation**

Create `src/search/vector.ts`:

```typescript
import type { IndexDb } from '../indexer/db.js';

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/**
 * Cosine similarity of `query` against every row, returning the top `k`
 * by score (desc), ties broken by symbol_id (asc) for determinism.
 * Vectors from the model are L2-normalized, but we divide by norms anyway
 * so hand-built test vectors and any future un-normalized input stay correct.
 */
export function cosineTopK(
  query: Float32Array,
  rows: Array<{ symbol_id: number; vec: Float32Array }>,
  k: number,
): Array<{ symbol_id: number; score: number }> {
  const qn = norm(query);
  const scored = rows.map((r) => {
    const denom = qn * norm(r.vec);
    return { symbol_id: r.symbol_id, score: denom === 0 ? 0 : dot(query, r.vec) / denom };
  });
  scored.sort((a, b) => b.score - a.score || a.symbol_id - b.symbol_id);
  return scored.slice(0, k);
}

export function vectorSearch(
  db: IndexDb,
  query: Float32Array,
  k: number,
): Array<{ symbol_id: number; score: number }> {
  // ponytail: brute-force cosine over all vectors; swap to sqlite-vec/hnsw above ~50k symbols
  return cosineTopK(query, db.allEmbeddings(), k);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- vector`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/search/vector.ts test/vector.test.ts
git commit -m "feat: brute-force cosine vector search"
```

---

### Task 4: Embedding model module + dependency + paths helper

**Files:**
- Create: `src/embed/model.ts`
- Modify: `src/paths.ts:13` (add `modelsDir`), `package.json` (add dep)
- Test: `test/embed-model.test.ts`

**Interfaces:**
- Produces (relied on by Tasks 6, 7):
  - `EMBEDDING_MODEL: string` (`'Xenova/all-MiniLM-L6-v2'`), `EMBEDDING_DIM: number` (`384`)
  - `class EmbeddingsUnavailable extends Error`
  - `warmupEmbedder(cacheDir: string): Promise<void>` — loads the pipeline; throws `EmbeddingsUnavailable` on failure.
  - `embed(texts: string[]): Promise<Float32Array[]>` — mean-pooled, L2-normalized; throws `EmbeddingsUnavailable` if called before a successful warmup.
  - `modelsDir(cwd: string): string` (in `paths.ts`) → `.sensei/models`.

- [ ] **Step 1: Add the dependency**

Run:

```bash
npm install @xenova/transformers@^2.17.2
```

Expected: `package.json` `dependencies` gains `"@xenova/transformers": "^2.17.2"`; lockfile updates.

- [ ] **Step 2: Write the failing test**

Create `test/embed-model.test.ts` (no model download — only the cheap, deterministic guards):

```typescript
import { describe, it, expect } from 'vitest';
import { EmbeddingsUnavailable, EMBEDDING_MODEL, EMBEDDING_DIM, embed } from '../src/embed/model.js';

describe('embedding model module', () => {
  it('exposes the model id and dimension', () => {
    expect(EMBEDDING_MODEL).toBe('Xenova/all-MiniLM-L6-v2');
    expect(EMBEDDING_DIM).toBe(384);
  });

  it('EmbeddingsUnavailable is an Error subclass', () => {
    const e = new EmbeddingsUnavailable('nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('EmbeddingsUnavailable');
  });

  it('embed before warmup throws EmbeddingsUnavailable', async () => {
    await expect(embed(['hello'])).rejects.toBeInstanceOf(EmbeddingsUnavailable);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- embed-model`
Expected: FAIL — cannot find module `../src/embed/model.js`.

- [ ] **Step 4: Write the model module**

Create `src/embed/model.ts`:

```typescript
import { pipeline, env, type FeatureExtractionPipeline } from '@xenova/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;

export class EmbeddingsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsUnavailable';
  }
}

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

/** Load and cache the ONNX model. Idempotent. Throws EmbeddingsUnavailable on failure. */
export async function warmupEmbedder(cacheDir: string): Promise<void> {
  if (extractor) return;
  if (!initPromise) {
    env.cacheDir = cacheDir;
    initPromise = pipeline('feature-extraction', EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>;
  }
  try {
    extractor = await initPromise;
  } catch (err) {
    initPromise = null;
    throw new EmbeddingsUnavailable(`could not load embedding model: ${(err as Error).message}`);
  }
}

/** Embed texts into mean-pooled, L2-normalized vectors. Requires a prior warmupEmbedder. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!extractor) throw new EmbeddingsUnavailable('embedder not initialized; call warmupEmbedder first');
  if (texts.length === 0) return [];
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return (output.tolist() as number[][]).map((row) => Float32Array.from(row));
}
```

> If TS reports that `FeatureExtractionPipeline` is not exported by the installed version, fall back to `import { pipeline, env, type Pipeline } from '@xenova/transformers'` and type `extractor` as `Pipeline | null`. Do not use `any`.

- [ ] **Step 5: Add the paths helper**

In `src/paths.ts`, add after the `dbPath` line:

```typescript
export const modelsDir = (cwd: string) => path.join(senseiDir(cwd), 'models');
```

- [ ] **Step 6: Run test + typecheck**

Run: `npm test -- embed-model && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/embed/model.ts src/paths.ts test/embed-model.test.ts
git commit -m "feat: local ONNX embedding model module"
```

---

### Task 5: Scorer — optional semantic-similarity term

**Files:**
- Modify: `src/scorer/score.ts:20-82` (`scoreCandidates`)
- Test: `test/scorer.test.ts`

**Interfaces:**
- Consumes: `config.scoring.semanticSim` (Task 1), `SymbolHitRow.symbol_id`.
- Produces: `scoreCandidates(hits, queryTokens, config, db, semanticSim?: Map<number, number>)`. The 5th param is **optional**; when absent, behavior is byte-for-byte unchanged (relied on by Task 7; every existing caller is unaffected).

- [ ] **Step 1: Write the failing test**

Add to `test/scorer.test.ts`:

```typescript
it('applies the semantic-sim term and reason when a map is supplied', async () => {
  const db = await buildIndex();
  const tokens = tokenize('login password');
  const hits = searchSymbols(db, tokens);
  const sim = new Map(hits.map((h) => [h.symbol_id, 1]));

  const withSim = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db, sim);
  const withoutSim = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db);

  const top = withSim[0];
  expect(top.reasons).toContain('semantically similar to task');
  // identical hit set, so compare the same symbol before/after: sim raises (or ties at clamp) its score
  const same = withoutSim.find((c) => c.name === top.name && c.path === top.path)!;
  expect(top.score).toBeGreaterThanOrEqual(same.score);
});

it('ignores the semantic term for symbols absent from the map (cosine treated as 0)', async () => {
  const db = await buildIndex();
  const tokens = tokenize('login password');
  const hits = searchSymbols(db, tokens);
  const ranked = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db, new Map());
  for (const r of ranked) expect(r.reasons).not.toContain('semantically similar to task');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scorer`
Expected: FAIL — `Expected "semantically similar to task" to be in [...]` (the 5th arg is ignored today).

- [ ] **Step 3: Add the parameter and term**

In `src/scorer/score.ts`, update the signature:

```typescript
export function scoreCandidates(
  hits: SymbolHitRow[],
  queryTokens: string[],
  config: SenseiConfig,
  db: IndexDb,
  semanticSim?: Map<number, number>,
): ReuseCandidate[] {
```

Inside the `hits.map((hit) => { ... })` body, add this block immediately **before** the `return {` statement (after the `tested.has(...)` block):

```typescript
    const cosine = semanticSim?.get(hit.symbol_id);
    if (cosine != null && cosine > 0) {
      score += w.semanticSim * cosine;
      reasons.push('semantically similar to task');
    }
```

The final `Math.max(0, Math.min(1, score))` clamp and the existing sort are unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scorer`
Expected: PASS — new cases green, and the pre-existing determinism/clamp/`login`-first cases still pass (no map passed there).

- [ ] **Step 5: Commit**

```bash
git add src/scorer/score.ts test/scorer.test.ts
git commit -m "feat: optional semantic-similarity term in scorer"
```

---

### Task 6: Scan path — embedding pass (post-commit, incremental, graceful)

**Files:**
- Modify: `src/core/run-scan.ts`
- Test: `test/embed-scan.test.ts`

**Interfaces:**
- Consumes: `warmupEmbedder`, `embed`, `EmbeddingsUnavailable`, `EMBEDDING_MODEL` (Task 4); `db.symbolsMissingEmbeddings`, `db.insertEmbedding`, `db.clearEmbeddings`, `db.getMeta`, `db.setMeta` (Task 2); `modelsDir` (Task 4).
- Produces: after a successful `runScan`, every symbol has an embedding row (when the model is available); `meta.embedding_model` records the model id. Relied on by Task 7's e2e.

**Why here and not in `indexFiles`:** `indexFiles` runs inside `db.raw.transaction(...)`, which `better-sqlite3` executes **synchronously** — `await embed(...)` is impossible inside it. The embedding pass therefore runs in `run-scan.ts` after `indexFiles` returns (the index is already committed). Incremental-ness is free: `deleteFilesNotIn` / `clearFileEntities` delete changed/removed symbols, whose embeddings cascade away, so `symbolsMissingEmbeddings()` is exactly the new/changed set.

- [ ] **Step 1: Write the failing test**

Create `test/embed-scan.test.ts`. It mocks the model module with a deterministic 3-dim fake (no download):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

// Deterministic fake: vector keyed off keywords in the text. No ONNX, no network.
const embedCalls: string[][] = [];
vi.mock('../src/embed/model.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/embed/model.js');
  return {
    ...actual,
    warmupEmbedder: vi.fn(async () => {}),
    embed: vi.fn(async (texts: string[]) => {
      embedCalls.push(texts);
      return texts.map((t) =>
        Float32Array.from([/auth|login/i.test(t) ? 1 : 0, /user/i.test(t) ? 1 : 0, /data/i.test(t) ? 1 : 0]),
      );
    }),
  };
});

import { runScan } from '../src/core/run-scan.js';
import { IndexDb } from '../src/indexer/db.js';
import { dbPath } from '../src/paths.js';
import fs from 'node:fs';
import os from 'node:os';

function tmpCopyOfRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-embed-'));
  fs.cpSync(repo, dir, { recursive: true });
  return dir;
}

describe('scan embedding pass', () => {
  beforeEach(() => embedCalls.splice(0));

  it('embeds every symbol and records the model id', async () => {
    const cwd = tmpCopyOfRepo();
    await runScan(cwd);
    const db = new IndexDb(dbPath(cwd));
    try {
      expect(db.countEmbeddings()).toBe(db.countSymbols());
      expect(db.symbolsMissingEmbeddings()).toEqual([]);
      expect(db.getMeta('embedding_model')).toBe('Xenova/all-MiniLM-L6-v2');
    } finally {
      db.close();
    }
  });

  it('is incremental: a second unchanged scan embeds nothing new', async () => {
    const cwd = tmpCopyOfRepo();
    await runScan(cwd);
    embedCalls.splice(0);
    await runScan(cwd);
    expect(embedCalls.flat()).toEqual([]); // no missing symbols → embed never called
  });
});

describe('scan embedding graceful fallback', () => {
  it('succeeds with zero embeddings when the model is unavailable', async () => {
    const model = await import('../src/embed/model.js');
    vi.mocked(model.warmupEmbedder).mockRejectedValueOnce(new model.EmbeddingsUnavailable('offline'));
    const cwd = tmpCopyOfRepo();
    const result = await runScan(cwd);
    expect(result.warnings.some((w) => /embeddings unavailable/i.test(w))).toBe(true);
    const db = new IndexDb(dbPath(cwd));
    try {
      expect(db.countEmbeddings()).toBe(0);
      expect(db.countSymbols()).toBeGreaterThan(0); // index still built
    } finally {
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- embed-scan`
Expected: FAIL — `db.countEmbeddings()` is `0`, not equal to symbol count (no embedding pass yet).

- [ ] **Step 3: Add the embedding pass to `runScan`**

Replace the body of `src/core/run-scan.ts` with:

```typescript
import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { scanRepo } from '../scanner/scan.js';
import { IndexDb } from '../indexer/db.js';
import { indexFiles, type IndexResult } from '../indexer/index-repo.js';
import { dbPath, senseiDir, modelsDir } from '../paths.js';
import { warmup } from '../ast/treesitter/runtime.js';
import { isTreeSitterLang } from '../lang.js';
import { warmupEmbedder, embed, EmbeddingsUnavailable, EMBEDDING_MODEL } from '../embed/model.js';
import { noopProgress, type ProgressFn } from './progress.js';

const EMBED_CHUNK = 256; // ponytail: bound peak memory; raise if throughput matters

export async function runScan(cwd: string, onProgress: ProgressFn = noopProgress): Promise<IndexResult> {
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  const config = loadConfig(cwd);
  const files = await scanRepo(cwd, config, onProgress);
  const db = new IndexDb(dbPath(cwd));
  try {
    db.migrate();
    const tsLangs = [...new Set(files.map((f) => f.lang))].filter(isTreeSitterLang);
    const warmWarnings = await warmup(tsLangs);
    const result = indexFiles(db, cwd, files, onProgress);
    result.warnings.push(...warmWarnings);
    await embedSymbols(db, cwd, result);
    db.setMeta('schema_version', '1');
    db.setMeta('last_scan', new Date().toISOString());
    return result;
  } finally {
    db.close();
  }
}

/** Embed any symbols that lack a vector. Incremental (cascade deletes free changed ones). */
async function embedSymbols(db: IndexDb, cwd: string, result: IndexResult): Promise<void> {
  // A model change invalidates every stored vector.
  if (db.getMeta('embedding_model') && db.getMeta('embedding_model') !== EMBEDDING_MODEL) {
    db.clearEmbeddings();
  }
  const missing = db.symbolsMissingEmbeddings();
  if (missing.length === 0) return;

  try {
    fs.mkdirSync(modelsDir(cwd), { recursive: true });
    await warmupEmbedder(modelsDir(cwd));
    for (let i = 0; i < missing.length; i += EMBED_CHUNK) {
      const batch = missing.slice(i, i + EMBED_CHUNK);
      const vecs = await embed(batch.map((m) => `${m.name} ${m.signature} ${m.jsdoc}`.trim()));
      const tx = db.raw.transaction(() => {
        batch.forEach((m, j) => db.insertEmbedding(m.symbol_id, vecs[j]));
      });
      tx();
    }
    db.setMeta('embedding_model', EMBEDDING_MODEL);
  } catch (err) {
    if (!(err instanceof EmbeddingsUnavailable)) throw err;
    result.warnings.push(`embeddings unavailable: ${err.message}; continuing lexical-only`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- embed-scan`
Expected: PASS (all 3 cases — full embed, incremental no-op, graceful fallback).

- [ ] **Step 5: Commit**

```bash
git add src/core/run-scan.ts test/embed-scan.test.ts
git commit -m "feat: embed symbols during scan (incremental, graceful)"
```

---

### Task 7: Context path — fuse vector hits into ranking

**Files:**
- Modify: `src/core/run-context.ts`
- Test: `test/embed-context.test.ts`

**Interfaces:**
- Consumes: `warmupEmbedder`, `embed`, `EmbeddingsUnavailable` (Task 4); `db.countEmbeddings`, `db.symbolsByIds` (Task 2); `vectorSearch` (Task 3); `scoreCandidates(..., semanticSim)` (Task 5); `modelsDir` (Task 4); `config.context.vectorTopK` (Task 1).
- Produces: `runContext` returns a report whose ranking includes the semantic term, and whose candidate set is the **union** of FTS hits and vector top-K (each symbol once). Embeddings empty/unavailable → lexical-only, no throw.

- [ ] **Step 1: Write the failing test**

Create `test/embed-context.test.ts`. Same deterministic fake as Task 6; it runs a real `scan` (which embeds via the fake), then asserts a vector-only symbol surfaces:

```typescript
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

vi.mock('../src/embed/model.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/embed/model.js');
  return {
    ...actual,
    warmupEmbedder: vi.fn(async () => {}),
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t) =>
        Float32Array.from([/auth|login/i.test(t) ? 1 : 0, /user/i.test(t) ? 1 : 0, /data/i.test(t) ? 1 : 0]),
      ),
    ),
  };
});

import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';

function tmpCopyOfRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ctx-'));
  fs.cpSync(repo, dir, { recursive: true });
  return dir;
}

describe('context semantic fusion', () => {
  it('surfaces a semantically-similar symbol once, with the semantic reason', async () => {
    const cwd = tmpCopyOfRepo();
    await runScan(cwd);
    // "authentication" shares the auth vector axis with login symbols but is lexically distinct
    const report = await runContext(cwd, 'authentication', { write: false });
    const names = report.reuseCandidates.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // union dedup: no symbol twice
    const semantic = report.reuseCandidates.find((c) => c.reasons.includes('semantically similar to task'));
    expect(semantic).toBeDefined();
  });
});

describe('context graceful fallback', () => {
  it('returns a lexical-only report when embeddings are unavailable', async () => {
    const cwd = tmpCopyOfRepo();
    await runScan(cwd); // embeds via the fake
    const model = await import('../src/embed/model.js');
    vi.mocked(model.warmupEmbedder).mockRejectedValueOnce(new model.EmbeddingsUnavailable('offline'));
    const report = await runContext(cwd, 'login with password', { write: false });
    expect(report.reuseCandidates.length).toBeGreaterThan(0);
    for (const c of report.reuseCandidates) {
      expect(c.reasons).not.toContain('semantically similar to task');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- embed-context`
Expected: FAIL — no candidate carries the `'semantically similar to task'` reason (context ignores vectors today).

- [ ] **Step 3: Wire fusion into `runContext`**

Replace the body of `src/core/run-context.ts` with:

```typescript
import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import type { SymbolHitRow } from '../indexer/db.js';
import { dbPath, modelsDir } from '../paths.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { vectorSearch } from '../search/vector.js';
import { warmupEmbedder, embed, EmbeddingsUnavailable } from '../embed/model.js';
import { scoreCandidates, findDangerousFiles } from '../scorer/score.js';
import { readAgentRules } from '../report/agent-rules.js';
import { buildReport, writeReport } from '../report/build.js';
import type { ContextReport } from '../types.js';

export interface ContextOptions {
  now?: Date;
  write?: boolean;
}

export async function runContext(
  cwd: string,
  task: string,
  opts: ContextOptions = {},
): Promise<ContextReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const db = new IndexDb(dbPath(cwd));
  try {
    const now = opts.now ?? new Date();
    const tokens = tokenize(task);
    let hits = searchSymbols(db, tokens);
    const semanticSim = await semanticSimilarity(db, cwd, task, hits, config.context.vectorTopK);
    if (semanticSim) {
      const known = new Set(hits.map((h) => h.symbol_id));
      const extraIds = [...semanticSim.keys()].filter((id) => !known.has(id));
      if (extraIds.length) hits = hits.concat(db.symbolsByIds(extraIds));
    }
    const ranked = scoreCandidates(hits, tokens, config, db, semanticSim).slice(0, config.context.topN);
    const dangerous = findDangerousFiles(db, config);
    const rules = readAgentRules(cwd);
    const report = buildReport(task, ranked, dangerous, rules, now);
    if (opts.write !== false) writeReport(cwd, report);
    return report;
  } finally {
    db.close();
  }
}

/** Embed the query and return a symbol_id → cosine map, or undefined if embeddings are absent/unavailable. */
async function semanticSimilarity(
  db: IndexDb,
  cwd: string,
  task: string,
  _hits: SymbolHitRow[],
  vectorTopK: number,
): Promise<Map<number, number> | undefined> {
  if (db.countEmbeddings() === 0) return undefined;
  try {
    await warmupEmbedder(modelsDir(cwd));
    const [queryVec] = await embed([task]);
    if (!queryVec) return undefined;
    const top = vectorSearch(db, queryVec, vectorTopK);
    return new Map(top.map((t) => [t.symbol_id, t.score]));
  } catch (err) {
    if (!(err instanceof EmbeddingsUnavailable)) throw err;
    return undefined; // lexical-only; scan already warned on the unavailable model
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- embed-context`
Expected: PASS (fusion surfaces the semantic candidate; fallback stays lexical-only).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS; typecheck clean. (Confirms the optional scorer param and config additions broke nothing.)

- [ ] **Step 6: Commit**

```bash
git add src/core/run-context.ts test/embed-context.test.ts
git commit -m "feat: fuse semantic vector hits into context ranking"
```

---

### Task 8: Docs — README, CHANGELOG, config reference

**Files:**
- Modify: `README.md` (How it works, Configuration, Roadmap), `CHANGELOG.md`

**Interfaces:** none (docs only). No version bump or publish here — release is a separate flow.

- [ ] **Step 1: Update README "How it works"**

In `README.md`, extend the `context` bullet (item 2 under "How it works") to mention semantic retrieval:

```markdown
2. **`context`** tokenizes your task, retrieves candidate symbols via FTS5 **and local embedding similarity** (offline ONNX, `all-MiniLM-L6-v2`), unions the two candidate sets, and scores them with a deterministic heuristic (name/signature overlap, path/domain match, exported, git-recency, tests-nearby, **semantic similarity**). It also flags high-fan-in "do not touch" files from the import graph.
```

- [ ] **Step 2: Update README "Configuration"**

Add to the configuration bullet list:

```markdown
- `context.topN` (reuse candidates surfaced) and `context.vectorTopK` (vector recall breadth before fusion, default `50`)
- scoring weights, including `scoring.semanticSim` (default `0.25`) for embedding similarity
```

And add a short note after the list:

```markdown
Embeddings are computed locally on `scan` with no API key. The model is cached under `.sensei/models/` on first run; later runs are offline. If the model can't load (e.g. no network on the very first run), Sensei warns and falls back to lexical-only retrieval — `scan` and `context` still work.
```

- [ ] **Step 3: Update README "Roadmap"**

Replace the Planned line:

```markdown
Planned: embeddings-based semantic retrieval. See the [full roadmap](docs/superpowers/specs/2026-06-20-sensei-roadmap.md) for what's next.
```

with:

```markdown
Semantic retrieval: local offline embeddings (`all-MiniLM-L6-v2`) fused into reuse ranking.

See the [full roadmap](docs/superpowers/specs/2026-06-20-sensei-roadmap.md) for what's next.
```

- [ ] **Step 4: Add the CHANGELOG entry**

At the top of `CHANGELOG.md` (above `## [0.9.0]`), add an `## [Unreleased]` section:

```markdown
## [Unreleased]

### Added

- **Embeddings-based semantic retrieval** — `context` now fuses local vector similarity into reuse ranking, surfacing symbols whose meaning matches the task even when no lexical token overlaps (e.g. query "login" finds `authenticate`). Vectors are computed on `scan` by a local ONNX model (`Xenova/all-MiniLM-L6-v2`, 384-dim) cached under `.sensei/models/`; no API key, offline after first fetch. Brute-force cosine over SQLite BLOBs (no new native deps). New config: `scoring.semanticSim` (default `0.25`), `context.vectorTopK` (default `50`). If the model can't load, Sensei warns and falls back to lexical-only — `scan`/`context` never crash.
```

- [ ] **Step 5: Verify docs build/lint and commit**

Run: `npm run typecheck`
Expected: clean (no code touched, but confirms nothing else broke).

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document embeddings-based semantic retrieval"
```

---

## Self-Review

**Spec coverage** (against [2026-06-18 design §4](../specs/2026-06-18-exporters-and-embeddings-design.md)):
- §4.1 dependency & model → Task 4 (dep, `EMBEDDING_MODEL`, `.sensei/models` cache).
- §4.2 schema + `insertEmbedding`/`allEmbeddings`/`countEmbeddings` + cascade + `embedding_model` meta → Task 2 (methods) + Task 6 (meta, model-change rebuild). `symbolsByIds` (design §4.5) → Task 2.
- §4.3 model module (async-warmup singleton, `EmbeddingsUnavailable`) → Task 4.
- §4.4 scan path (changed-file embed, batch, incremental, graceful) → Task 6. **Deviation (documented):** runs in `run-scan.ts` post-commit, not in `indexFiles`, because the index write is a synchronous transaction; incremental-ness comes from `symbolsMissingEmbeddings()` + cascade rather than threading the changed-file list.
- §4.5 context path (FTS + vector, union, hydrate vector-only ids, `Map` into scorer, graceful) → Task 7; `vectorSearch` → Task 3.
- §4.6 scorer term + reason + clamp/tie-break → Task 5.
- §4.7 config `scoring.semanticSim`, `context.vectorTopK` → Task 1.
- §4.8 tests: cosine ordering (T3), BLOB round-trip (T2), union dedup (T7), scorer term (T5), graceful fallback scan+context (T6, T7) → all covered. **Deviation:** real model load is not unit-tested (would need a network download); tests mock `../src/embed/model.js`. Stated in Global Constraints.

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step shows complete code; the two `ponytail:` comments name real ceilings (brute-force cosine, embed chunk size) with upgrade paths — these are intentional, not placeholders.

**Type consistency:** `symbol_id: number` throughout (DB rows, `cosineTopK`, `semanticSim` map keys, scorer lookup). `Float32Array` is the vector type at every boundary (`insertEmbedding`, `allEmbeddings`, `embed`, `cosineTopK`, `vectorSearch`). `semanticSim?: Map<number, number>` matches between Task 5 (definition) and Task 7 (call site). `warmupEmbedder(cacheDir)` / `embed(texts)` signatures match between Task 4, 6, 7. Reason string `'semantically similar to task'` is identical in Task 5 (push) and Tasks 5/6/7 (assertions).
