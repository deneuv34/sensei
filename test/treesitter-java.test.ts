import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';

const SRC = `
package com.example;

public class Server {
    public Server start(int port) {
        return this;
    }
    private void internalOnly() {}
}

interface Handler {
    boolean handle(String req);
}

enum State { IDLE, RUNNING }
`;

describe('java extractor', () => {
  beforeAll(async () => { await warmup(['java']); });

  it('extracts class and public methods qualified by class', () => {
    const { symbols } = extractTreeSitter('java', SRC);
    expect(symbols.find((s) => s.name === 'Server' && s.kind === 'class')).toBeTruthy();
    const m = symbols.find((s) => s.name === 'Server.start' && s.kind === 'method')!;
    expect(m.exported).toBe(true);
    expect(m.signature).toContain('Server.start(int port)');
  });

  it('marks non-public methods as not exported', () => {
    const { symbols } = extractTreeSitter('java', SRC);
    expect(symbols.find((s) => s.name === 'Server.internalOnly')!.exported).toBe(false);
  });

  it('maps interface and enum declarations', () => {
    const { symbols } = extractTreeSitter('java', SRC);
    expect(symbols.find((s) => s.name === 'Handler' && s.kind === 'interface')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'State' && s.kind === 'enum')).toBeTruthy();
  });
});
