import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { symbolSimilarity, duplicateFindings, dangerousFindings } from '../src/validate/checks.js';
import type { ExtractedSymbol } from '../src/types.js';

const sym = (name: string, signature: string, startLine = 1): ExtractedSymbol =>
  ({ kind: 'function', name, signature, exported: true, startLine, jsdoc: '' });

function seedLogin(): IndexDb {
  const db = new IndexDb(':memory:');
  db.migrate();
  const id = db.upsertFile({
    path: 'src/auth/login.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0,
  });
  db.insertSymbol(id, sym('login', 'login(email: string, password: string): boolean', 2), 'src/auth/login.ts');
  return db;
}

describe('symbolSimilarity', () => {
  it('is 1.0 for identical name and signature', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(email: string, password: string): boolean' },
      { name: 'login', signature: 'login(email: string, password: string): boolean' },
    )).toBeCloseTo(1, 5);
  });

  it('caps a name-only match at 0.5', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(): void' },
      { name: 'login', signature: 'somethingElse(a: Foo, b: Bar): Baz' },
    )).toBeLessThanOrEqual(0.5);
  });
});

describe('duplicateFindings', () => {
  it('flags a same-name same-signature reimplementation in another file', () => {
    const db = seedLogin();
    const introduced = [sym('login', 'login(email: string, password: string): boolean', 1)];
    const out = duplicateFindings(db, DEFAULT_CONFIG, 'src/auth/relogin.ts', introduced, 'warn');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('duplicate-candidate');
    expect(out[0].related?.path).toBe('src/auth/login.ts');
    expect(out[0].related?.score).toBeGreaterThanOrEqual(DEFAULT_CONFIG.validate.duplicateThreshold);
    db.close();
  });

  it('excludes a match in the same file (moved/renamed self)', () => {
    const db = seedLogin();
    const introduced = [sym('login', 'login(email: string, password: string): boolean', 1)];
    expect(duplicateFindings(db, DEFAULT_CONFIG, 'src/auth/login.ts', introduced, 'warn')).toEqual([]);
    db.close();
  });

  it('does not flag a near-miss below threshold', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const id = db.upsertFile({ path: 'src/u.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    db.insertSymbol(id, sym('createUser', 'createUser(name: string): User', 1), 'src/u.ts');
    const introduced = [sym('createUserProfile', 'createUserProfile(name: string, age: number): Profile', 1)];
    expect(duplicateFindings(db, DEFAULT_CONFIG, 'src/p.ts', introduced, 'warn')).toEqual([]);
    db.close();
  });

  it('suppresses symbols whose name tokenizes to nothing', () => {
    const db = seedLogin();
    const introduced = [sym('x', 'x(): void', 1)];
    expect(duplicateFindings(db, DEFAULT_CONFIG, 'src/x.ts', introduced, 'warn')).toEqual([]);
    db.close();
  });
});

describe('dangerousFindings', () => {
  it('flags a changed entrypoint file', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile({ path: 'src/index.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    const out = dangerousFindings(db, DEFAULT_CONFIG, ['src/index.ts'], 'warn');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('dangerous-edit');
    expect(out[0].file).toBe('src/index.ts');
    db.close();
  });

  it('does not flag an ordinary changed file', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile({ path: 'src/util.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    expect(dangerousFindings(db, DEFAULT_CONFIG, ['src/util.ts'], 'warn')).toEqual([]);
    db.close();
  });
});
