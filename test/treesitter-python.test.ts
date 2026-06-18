import { describe, it, expect, beforeAll } from 'vitest';
import { warmup } from '../src/ast/treesitter/runtime.js';
import { extractTreeSitter } from '../src/ast/treesitter/extract.js';

const SRC = `
CONST_TTL = 3600
_private_const = 1

def top_level(a, b):
    """Adds two."""
    return a + b

def _helper(x):
    return x

class Service:
    def handle(self, req):
        """Handle a request."""
        def nested():
            return 1
        return nested()
`;

describe('python extractor', () => {
  beforeAll(async () => { await warmup(['py']); });

  it('extracts module functions with signature and docstring', () => {
    const { symbols } = extractTreeSitter('py', SRC);
    const fn = symbols.find((s) => s.name === 'top_level')!;
    expect(fn.kind).toBe('function');
    expect(fn.exported).toBe(true);
    expect(fn.signature).toBe('top_level(a, b)');
    expect(fn.jsdoc).toContain('Adds two');
  });

  it('marks underscore-prefixed names as not exported', () => {
    const { symbols } = extractTreeSitter('py', SRC);
    expect(symbols.find((s) => s.name === '_helper')!.exported).toBe(false);
  });

  it('extracts classes and qualified methods, skipping nested functions', () => {
    const { symbols } = extractTreeSitter('py', SRC);
    expect(symbols.find((s) => s.name === 'Service' && s.kind === 'class')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'Service.handle' && s.kind === 'method')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'nested')).toBeUndefined();
  });

  it('extracts ALL_CAPS module constants only', () => {
    const { symbols } = extractTreeSitter('py', SRC);
    expect(symbols.find((s) => s.name === 'CONST_TTL' && s.kind === 'const')).toBeTruthy();
    expect(symbols.find((s) => s.name === '_private_const')).toBeUndefined();
  });

  it('returns no imports (reuse-only parity)', () => {
    expect(extractTreeSitter('py', SRC).imports).toEqual([]);
  });
});
