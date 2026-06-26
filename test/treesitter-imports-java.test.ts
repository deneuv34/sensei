import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
package com.example.app;

import com.example.auth.Token;
import com.example.auth.*;
import java.util.List;
`;

describe('java import extractor', () => {
  beforeAll(async () => { await warmup(['java']); });

  it('extracts single-class imports', () => {
    const { imports } = extractTreeSitter('java', SRC);
    expect(imports.find((i) => i.module === 'com.example.auth.Token' && i.importedName === 'Token')).toBeTruthy();
  });

  it('extracts wildcard imports with the package as module', () => {
    const { imports } = extractTreeSitter('java', SRC);
    expect(imports.find((i) => i.module === 'com.example.auth' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts stdlib imports (kept as edges; resolver drops them)', () => {
    const { imports } = extractTreeSitter('java', SRC);
    expect(imports.find((i) => i.module === 'java.util.List')).toBeTruthy();
  });

  it('resolves a class import to its .java file', () => {
    const resolve = importExtractors['java']!.resolveImport;
    const known = new Set(['com/example/auth/Token.java', 'com/example/app/Main.java']);
    expect(resolve('com/example/app/Main.java', 'com.example.auth.Token', known))
      .toEqual(['com/example/auth/Token.java']);
  });

  it('resolves a wildcard import to every .java file in the package dir', () => {
    const resolve = importExtractors['java']!.resolveImport;
    const known = new Set([
      'com/example/auth/Token.java', 'com/example/auth/Session.java', 'com/example/app/Main.java',
    ]);
    expect(resolve('com/example/app/Main.java', 'com.example.auth', known).sort())
      .toEqual(['com/example/auth/Session.java', 'com/example/auth/Token.java']);
  });

  it('returns [] for an external (java.*) package', () => {
    const resolve = importExtractors['java']!.resolveImport;
    expect(resolve('com/example/app/Main.java', 'java.util.List', new Set(['com/example/app/Main.java'])))
      .toEqual([]);
  });

  it('does not fall through to dir matching for an unresolved class import (PascalCase)', () => {
    const resolve = importExtractors['java']!.resolveImport;
    // A class `Token` not in the repo, but a `Token/` directory with files exists.
    // The PascalCase last segment should prevent dir fall-through.
    const known = new Set(['com/example/auth/Token/inner.java', 'com/example/app/Main.java']);
    expect(resolve('com/example/app/Main.java', 'com.example.auth.Token', known)).toEqual([]);
  });

  it('extracts static imports (member import; resolver drops to no edge)', () => {
    const { imports } = extractTreeSitter('java', 'import static com.example.auth.Token.valueOf;');
    expect(imports.find((i) => i.module === 'com.example.auth.Token.valueOf' && i.importedName === 'valueOf')).toBeTruthy();
    // Static imports target a member (method/field), not a class file — resolution returns no edge.
    const resolve = importExtractors['java']!.resolveImport;
    expect(resolve('com/example/app/Main.java', 'com.example.auth.Token.valueOf', new Set(['com/example/auth/Token.java'])))
      .toEqual([]);
  });
});
