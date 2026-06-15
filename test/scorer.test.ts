import { describe, it, expect } from 'vitest';
import { scoreCandidates, findDangerousFiles } from '../src/scorer/score.js';
import { IndexDb } from '../src/indexer/db.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { scanRepo } from '../src/scanner/scan.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { searchSymbols } from '../src/search/search.js';
import { tokenize } from '../src/text/tokenize.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

async function buildIndex() {
  const db = new IndexDb(':memory:');
  db.migrate();
  indexFiles(db, repo, await scanRepo(repo, DEFAULT_CONFIG));
  return db;
}

describe('scoreCandidates', () => {
  it('ranks the most relevant exported symbol first and is deterministic', async () => {
    const db = await buildIndex();
    const tokens = tokenize('add login with password');
    const hits = searchSymbols(db, tokens);
    const ranked = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[ranked.length - 1].score);
    expect(ranked[0].name).toBe('login');
    expect(ranked[0].reasons.length).toBeGreaterThan(0);
    // determinism: same inputs -> identical ranking
    const again = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db);
    expect(again.map((r) => `${r.name}:${r.score}`)).toEqual(ranked.map((r) => `${r.name}:${r.score}`));
  });

  it('scores are clamped to [0,1]', async () => {
    const db = await buildIndex();
    const tokens = tokenize('login password');
    const ranked = scoreCandidates(searchSymbols(db, tokens), tokens, DEFAULT_CONFIG, db);
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('findDangerousFiles', () => {
  it('flags high-fan-in files and entrypoints', async () => {
    const db = await buildIndex();
    const cfg = { ...DEFAULT_CONFIG, dangerous: { importerThreshold: 2 } };
    const danger = findDangerousFiles(db, cfg);
    expect(danger.some((d) => d.path === 'src/auth/login.ts')).toBe(true);
    expect(danger.some((d) => d.path === 'src/index.ts')).toBe(true); // entrypoint
  });
});
