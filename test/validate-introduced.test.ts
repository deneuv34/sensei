import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import { introducedSymbols } from '../src/validate/introduced.js';

function seed(): IndexDb {
  const db = new IndexDb(':memory:');
  db.migrate();
  const id = db.upsertFile({
    path: 'src/auth/login.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0,
  });
  db.insertSymbol(id, {
    kind: 'function', name: 'login', signature: 'login(email: string, password: string): boolean',
    exported: true, startLine: 2, jsdoc: '',
  }, 'src/auth/login.ts');
  return db;
}

describe('introducedSymbols', () => {
  it('treats a symbol already in the index (same name+kind+signature) as not introduced', () => {
    const db = seed();
    const source = 'export function login(email: string, password: string): boolean { return true; }\n';
    expect(introducedSymbols(db, 'src/auth/login.ts', source)).toEqual([]);
    db.close();
  });

  it('flags a brand-new symbol in an unindexed file as introduced', () => {
    const db = seed();
    const source = 'export function login(email: string, password: string): boolean { return false; }\n';
    const introduced = introducedSymbols(db, 'src/auth/relogin.ts', source);
    expect(introduced.map((s) => s.name)).toEqual(['login']);
    db.close();
  });

  it('flags a changed signature as introduced (new surface area)', () => {
    const db = seed();
    const source = 'export function login(token: string): boolean { return !!token; }\n';
    const introduced = introducedSymbols(db, 'src/auth/login.ts', source);
    expect(introduced.map((s) => s.signature)).toEqual(['login(token: string): boolean']);
    db.close();
  });
});
