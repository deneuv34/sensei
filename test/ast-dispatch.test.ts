import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/ast/extract.js';

describe('extractFromSource dispatch', () => {
  it('still extracts TS via the typescript backend', () => {
    const { symbols } = extractFromSource('x.ts', 'export function foo(a: number): number { return a; }');
    expect(symbols.find((s) => s.name === 'foo' && s.kind === 'function')).toBeTruthy();
  });

  it('routes unknown-but-tree-sitter langs without throwing (stub returns empty)', () => {
    const out = extractFromSource('x.py', 'def foo():\n    pass\n');
    expect(out).toEqual({ symbols: [], imports: [] });
  });
});
