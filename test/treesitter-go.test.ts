import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';

const SRC = `
package main

const MaxRetries = 3

type Server struct {
	addr string
}

type Handler interface {
	Handle(req string) error
}

func NewServer(addr string) *Server {
	return &Server{addr: addr}
}

func (s *Server) Start(port int) error {
	return nil
}

func internalOnly() {}
`;

describe('go extractor', () => {
  beforeAll(async () => { await warmup(['go']); });

  it('extracts exported functions by capitalization', () => {
    const { symbols } = extractTreeSitter('go', SRC);
    const fn = symbols.find((s) => s.name === 'NewServer')!;
    expect(fn.kind).toBe('function');
    expect(fn.exported).toBe(true);
    expect(fn.signature).toContain('NewServer(addr string)');
    expect(symbols.find((s) => s.name === 'internalOnly')!.exported).toBe(false);
  });

  it('extracts methods qualified by receiver type', () => {
    const { symbols } = extractTreeSitter('go', SRC);
    expect(symbols.find((s) => s.name === 'Server.Start' && s.kind === 'method')).toBeTruthy();
  });

  it('maps struct->class and interface->interface', () => {
    const { symbols } = extractTreeSitter('go', SRC);
    expect(symbols.find((s) => s.name === 'Server' && s.kind === 'class')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'Handler' && s.kind === 'interface')).toBeTruthy();
  });

  it('extracts consts', () => {
    const { symbols } = extractTreeSitter('go', SRC);
    expect(symbols.find((s) => s.name === 'MaxRetries' && s.kind === 'const')).toBeTruthy();
  });
});
