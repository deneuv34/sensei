import { describe, it, expect } from 'vitest';
import { langOfPath, isTreeSitterLang } from '../src/lang.js';

describe('langOfPath', () => {
  it('maps known extensions to languages', () => {
    expect(langOfPath('a/b.ts')).toBe('ts');
    expect(langOfPath('a/b.tsx')).toBe('tsx');
    expect(langOfPath('a/b.jsx')).toBe('jsx');
    expect(langOfPath('a/b.py')).toBe('py');
    expect(langOfPath('a/b.go')).toBe('go');
    expect(langOfPath('a/b.rs')).toBe('rust');
    expect(langOfPath('a/b.java')).toBe('java');
    expect(langOfPath('a/b.mjs')).toBe('js');
  });

  it('classifies tree-sitter languages', () => {
    expect(isTreeSitterLang('py')).toBe(true);
    expect(isTreeSitterLang('java')).toBe(true);
    expect(isTreeSitterLang('ts')).toBe(false);
    expect(isTreeSitterLang('js')).toBe(false);
  });
});
