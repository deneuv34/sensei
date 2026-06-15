import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/indexer/db.js';
import { scanRepo } from '../src/scanner/scan.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('indexFiles', () => {
  it('indexes symbols, resolves the import graph, and computes importer_count', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const files = await scanRepo(repo, DEFAULT_CONFIG);
    const result = indexFiles(db, repo, files);

    expect(result.fileCount).toBe(files.length);
    expect(result.symbolCount).toBeGreaterThan(0);

    // login.ts is imported by index.ts, profile.ts, and login.test.ts
    const login = db.getFileByPath('src/auth/login.ts')!;
    expect(login.importer_count).toBeGreaterThanOrEqual(2);

    // FTS search finds the login function
    const hits = db.searchSymbols('"login"', 50);
    expect(hits.some((h) => h.name === 'login')).toBe(true);
  });

  it('is incremental: a second run with unchanged files re-parses nothing', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const files = await scanRepo(repo, DEFAULT_CONFIG);
    indexFiles(db, repo, files);
    const second = indexFiles(db, repo, files);
    expect(second.changed).toBe(0);
  });
});
