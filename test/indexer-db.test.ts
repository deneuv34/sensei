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

describe('symbolsForFile', () => {
  it('returns name/kind/signature for a file path, empty for unknown', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const fileId = db.upsertFile({
      path: 'src/a.ts', hash: 'h', lang: 'ts', loc: 3, gitLastModified: null, gitCommitCount: 0,
    });
    db.insertSymbol(fileId, {
      kind: 'function', name: 'foo', signature: 'foo(x: number): void',
      exported: true, startLine: 1, jsdoc: '',
    }, 'src/a.ts');

    expect(db.symbolsForFile('src/a.ts')).toEqual([
      { name: 'foo', kind: 'function', signature: 'foo(x: number): void' },
    ]);
    expect(db.symbolsForFile('src/missing.ts')).toEqual([]);
    db.close();
  });
});

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
