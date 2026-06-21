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
