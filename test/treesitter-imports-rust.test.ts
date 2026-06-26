import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';

const SRC = `
use std::collections::HashMap;
use crate::auth::token::Token;
use crate::auth::token::*;
use super::logger;
mod config;
`;

describe('rust import extractor', () => {
  beforeAll(async () => { await warmup(['rust']); });

  it('extracts use declarations', () => {
    const { imports } = extractTreeSitter('rust', SRC);
    expect(imports.find((i) => i.module === 'std::collections::HashMap' && i.importedName === '*')).toBeTruthy();
    expect(imports.find((i) => i.module === 'crate::auth::token::Token' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts wildcard use as module without the trailing ::*', () => {
    const { imports } = extractTreeSitter('rust', SRC);
    expect(imports.find((i) => i.module === 'crate::auth::token' && i.importedName === '*')).toBeTruthy();
  });

  it('extracts super-relative use and mod declarations', () => {
    const { imports } = extractTreeSitter('rust', SRC);
    expect(imports.find((i) => i.module === 'super::logger')).toBeTruthy();
    expect(imports.find((i) => i.module === 'mod:config')).toBeTruthy();
  });

  it('resolves crate:: absolute use to a file or mod.rs', () => {
    const resolve = importExtractors['rust']!.resolveImport;
    const known = new Set(['src/auth/token.rs', 'src/auth/mod.rs']);
    expect(resolve('src/main.rs', 'crate::auth::token::Token', known)).toEqual(['src/auth/token.rs']);
  });

  it('resolves super:: relative use against the importer parent', () => {
    const resolve = importExtractors['rust']!.resolveImport;
    const known = new Set(['src/logger.rs', 'src/auth/mod.rs']);
    expect(resolve('src/auth/mod.rs', 'super::logger', known)).toEqual(['src/logger.rs']);
  });

  it('resolves a mod declaration to a sibling file or mod.rs', () => {
    const resolve = importExtractors['rust']!.resolveImport;
    const known = new Set(['src/config.rs', 'src/main.rs']);
    expect(resolve('src/main.rs', 'mod:config', known)).toEqual(['src/config.rs']);
  });
});
