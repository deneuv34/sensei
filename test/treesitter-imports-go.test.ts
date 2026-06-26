import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
package main

import "fmt"
import "github.com/foo/bar/internal/auth"

import (
  "errors"
  "github.com/foo/bar/internal/util"
)
`;

describe('go import extractor', () => {
  beforeAll(async () => { await warmup(['go']); });

  it('extracts single and grouped imports', () => {
    const { imports } = extractTreeSitter('go', SRC);
    const mods = imports.map((i) => i.module).sort();
    expect(mods).toEqual(['errors', 'fmt', 'github.com/foo/bar/internal/auth', 'github.com/foo/bar/internal/util']);
    expect(imports.every((i) => i.importedName === '*')).toBe(true);
  });

  it('resolves an internal package import to every .go file in the matching dir (longest path suffix)', () => {
    const resolve = importExtractors['go']!.resolveImport;
    const known = new Set([
      'internal/auth/auth.go', 'internal/auth/token.go', 'internal/util.go',
      'main.go',
    ]);
    expect(resolve('main.go', 'github.com/foo/bar/internal/auth', known).sort())
      .toEqual(['internal/auth/auth.go', 'internal/auth/token.go']);
  });

  it('resolves a stdlib-looking path that happens to match a dir', () => {
    const resolve = importExtractors['go']!.resolveImport;
    const known = new Set(['errors.go']);
    expect(resolve('main.go', 'errors', known)).toEqual(['errors.go']);
  });

  it('returns [] when no dir path is a suffix of the import path', () => {
    const resolve = importExtractors['go']!.resolveImport;
    expect(resolve('main.go', 'github.com/foo/bar/missing', new Set(['main.go']))).toEqual([]);
  });
});
