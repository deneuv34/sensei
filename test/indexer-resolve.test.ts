import { describe, it, expect } from 'vitest';
import { resolveImports } from '../src/indexer/resolve.js';

describe('resolveImports', () => {
  const known = new Set(['src/util.ts', 'src/util/index.ts', 'src/index.ts']);

  it('resolves a relative TS specifier to a file', () => {
    expect(resolveImports('src/mod.ts', './util', known)).toEqual(['src/util.ts']);
  });

  it('resolves a TS barrel import to index.ts', () => {
    expect(resolveImports('src/mod.ts', './util/index', known)).toEqual(['src/util/index.ts']);
  });

  it('returns [] for an external TS package', () => {
    expect(resolveImports('src/mod.ts', 'react', known)).toEqual([]);
  });

  it('returns [] for a tree-sitter lang with no extractor registered', () => {
    expect(resolveImports('src/mod.py', 'util', known)).toEqual([]);
  });
});
