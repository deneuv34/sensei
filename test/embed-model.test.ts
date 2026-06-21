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
