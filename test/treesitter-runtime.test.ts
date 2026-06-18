import { describe, it, expect } from 'vitest';
import { warmup, getParser } from '../src/ast/treesitter/runtime.js';

describe('tree-sitter runtime', () => {
  it('returns no parser before warmup', () => {
    expect(getParser('go')).toBeUndefined();
  });

  it('warms a grammar and parses a trivial snippet', async () => {
    const warnings = await warmup(['py']);
    expect(warnings).toEqual([]);
    const parser = getParser('py');
    expect(parser).toBeDefined();
    const tree = parser!.parse('x = 1\n');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('module');
  });
});
