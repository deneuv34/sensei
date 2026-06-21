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
