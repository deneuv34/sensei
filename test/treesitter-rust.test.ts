import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';

const SRC = `
pub const MAX: u32 = 10;

pub struct Server {
    addr: String,
}

pub trait Handler {
    fn handle(&self, req: u32) -> bool;
}

pub enum State { Idle, Running }

pub type Id = u64;

pub fn new_server(addr: String) -> Server {
    Server { addr }
}

fn internal_only() {}

impl Server {
    pub fn start(&self, port: u16) -> bool {
        true
    }
}
`;

describe('rust extractor', () => {
  beforeAll(async () => { await warmup(['rust']); });

  it('extracts pub functions with signature and visibility', () => {
    const { symbols } = extractTreeSitter('rust', SRC);
    const fn = symbols.find((s) => s.name === 'new_server')!;
    expect(fn.kind).toBe('function');
    expect(fn.exported).toBe(true);
    expect(fn.signature).toContain('new_server(addr: String) -> Server');
    expect(symbols.find((s) => s.name === 'internal_only')!.exported).toBe(false);
  });

  it('maps struct->class, trait->interface, enum->enum, type->type', () => {
    const { symbols } = extractTreeSitter('rust', SRC);
    expect(symbols.find((s) => s.name === 'Server' && s.kind === 'class')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'Handler' && s.kind === 'interface')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'State' && s.kind === 'enum')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'Id' && s.kind === 'type')).toBeTruthy();
  });

  it('extracts impl methods qualified by type', () => {
    const { symbols } = extractTreeSitter('rust', SRC);
    expect(symbols.find((s) => s.name === 'Server.start' && s.kind === 'method')).toBeTruthy();
  });

  it('extracts consts', () => {
    const { symbols } = extractTreeSitter('rust', SRC);
    expect(symbols.find((s) => s.name === 'MAX' && s.kind === 'const')).toBeTruthy();
  });
});
