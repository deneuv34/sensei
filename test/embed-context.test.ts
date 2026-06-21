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
import { IndexDb } from '../src/indexer/db.js';
import { dbPath } from '../src/paths.js';

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
    const db = new IndexDb(dbPath(cwd));
    try {
      expect(db.countEmbeddings()).toBeGreaterThan(0); // proves the warmupEmbedder rejection exercises the EmbeddingsUnavailable catch path, not the countEmbeddings()===0 short-circuit
    } finally {
      db.close();
    }
    const model = await import('../src/embed/model.js');
    vi.mocked(model.warmupEmbedder).mockRejectedValueOnce(new model.EmbeddingsUnavailable('offline'));
    const report = await runContext(cwd, 'login with password', { write: false });
    expect(report.reuseCandidates.length).toBeGreaterThan(0);
    for (const c of report.reuseCandidates) {
      expect(c.reasons).not.toContain('semantically similar to task');
    }
  });
});
