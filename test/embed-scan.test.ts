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
