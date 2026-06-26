import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
import os
import a.b.c
from .util import format_currency
from ..foo import bar, baz
from .pkg import *
`;

describe('python import extractor', () => {
  beforeAll(async () => { await warmup(['py']); });

  it('extracts plain and dotted imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    expect(imports.find((i) => i.module === 'os' && i.importedName === '*')).toBeTruthy();
    expect(imports.find((i) => i.module === 'a.b.c' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts relative from-imports with named imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    const util = imports.filter((i) => i.module === '.util');
    expect(util.map((i) => i.importedName)).toContain('format_currency');
  });

  it('extracts parent-relative from-imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    const foo = imports.filter((i) => i.module === '..foo');
    expect(foo.map((i) => i.importedName)).toEqual(expect.arrayContaining(['bar', 'baz']));
  });

  it('extracts wildcard from-imports', () => {
    const { imports } = extractTreeSitter('py', SRC);
    expect(imports.find((i) => i.module === '.pkg' && i.importedName === '*')).toBeTruthy();
  });

  it('resolves a relative from-import to a sibling .py file', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['pkg/util.py', 'pkg/mod.py', 'pkg/util/__init__.py']);
    expect(resolve('pkg/mod.py', '.util', known)).toEqual(['pkg/util.py']);
  });

  it('resolves a parent-relative from-import', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['pkg/foo.py', 'pkg/sub/mod.py']);
    expect(resolve('pkg/sub/mod.py', '..foo', known)).toEqual(['pkg/foo.py']);
  });

  it('resolves a dotted absolute import to a module file or __init__', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['a/b/c/__init__.py']);
    expect(resolve('pkg/mod.py', 'a.b.c', known)).toEqual(['a/b/c/__init__.py']);
  });

  it('returns [] for an external (non-relative, non-repo) module', () => {
    const resolve = importExtractors['py']!.resolveImport;
    expect(resolve('pkg/mod.py', 'os', new Set(['pkg/mod.py']))).toEqual([]);
  });

  it('resolves a bare-relative from-import to __init__.py', () => {
    const resolve = importExtractors['py']!.resolveImport;
    const known = new Set(['pkg/__init__.py', 'pkg/mod.py']);
    expect(resolve('pkg/mod.py', '.', known)).toEqual(['pkg/__init__.py']);
  });

  it('extracts a bare-relative from-import', () => {
    const { imports } = extractTreeSitter('py', 'from . import x\n');
    expect(imports.find((i) => i.module === '.' && i.importedName === 'x')).toBeTruthy();
  });
});
