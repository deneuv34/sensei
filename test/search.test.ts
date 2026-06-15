import { describe, it, expect } from 'vitest';
import { buildMatchExpr, searchSymbols } from '../src/search/search.js';
import { IndexDb } from '../src/indexer/db.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { scanRepo } from '../src/scanner/scan.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('search', () => {
  it('builds a quoted OR FTS expression', () => {
    expect(buildMatchExpr(['login', 'password'])).toBe('"login" OR "password"');
  });

  it('returns [] for no tokens', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    expect(searchSymbols(db, [])).toEqual([]);
  });

  it('finds symbols matching task tokens', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    indexFiles(db, repo, await scanRepo(repo, DEFAULT_CONFIG));
    const hits = searchSymbols(db, ['login', 'password']);
    expect(hits.some((h) => h.name === 'login')).toBe(true);
    expect(hits.some((h) => h.name === 'hashPassword')).toBe(true);
  });
});
