import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import type { ScannedFile } from '../src/types.js';

function file(over: Partial<ScannedFile> = {}): ScannedFile {
  return { path: 'src/a.ts', hash: 'h1', lang: 'ts', loc: 10, gitLastModified: 100, gitCommitCount: 2, ...over };
}

describe('IndexDb file rows', () => {
  it('creates schema and upserts a file, returning a stable id', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const id = db.upsertFile(file());
    expect(id).toBeGreaterThan(0);
    const again = db.upsertFile(file({ hash: 'h2', loc: 20 }));
    expect(again).toBe(id); // same path -> same row
    const row = db.getFileByPath('src/a.ts');
    expect(row?.hash).toBe('h2');
    expect(row?.loc).toBe(20);
    db.close();
  });

  it('lists all files and deletes files not in a kept set', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile(file({ path: 'src/a.ts' }));
    db.upsertFile(file({ path: 'src/b.ts' }));
    db.deleteFilesNotIn(['src/a.ts']);
    expect(db.allFiles().map((f) => f.path)).toEqual(['src/a.ts']);
    db.close();
  });

  it('stores and reads meta', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.setMeta('schema_version', '1');
    expect(db.getMeta('schema_version')).toBe('1');
    expect(db.getMeta('missing')).toBeUndefined();
    db.close();
  });
});
