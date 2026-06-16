import { describe, it, expect } from 'vitest';
import { parsePlan } from '../src/validate/plan-parse.js';

describe('parsePlan — structured sections', () => {
  it('extracts file targets from a "Files to Create" section with create action', () => {
    const plan = [
      '## Files to Create',
      '- `src/payments/refund-v2.service.ts`',
      '- src/payments/refund.repository.ts',
    ].join('\n');
    const files = parsePlan(plan).filter((t) => t.kind === 'file');
    expect(files.map((f) => f.value).sort()).toEqual([
      'src/payments/refund-v2.service.ts',
      'src/payments/refund.repository.ts',
    ]);
    expect(files.every((f) => f.action === 'create' && f.confidence === 'high')).toBe(true);
  });

  it('extracts symbol targets from a "New Symbols" section', () => {
    const plan = ['### New Symbols', '- `PartialRefundService`', '- createPartialRefund()'].join('\n');
    const syms = parsePlan(plan).filter((t) => t.kind === 'symbol');
    expect(syms.map((s) => s.value).sort()).toEqual(['PartialRefundService', 'createPartialRefund']);
    expect(syms.every((s) => s.confidence === 'high')).toBe(true);
  });
});

describe('parsePlan — heuristic fallback', () => {
  it('finds a file path and a PascalCase symbol in prose', () => {
    const plan = 'We will create RefundManager in `src/payments/manager.ts` to own refunds.';
    const targets = parsePlan(plan);
    expect(targets.find((t) => t.kind === 'file')?.value).toBe('src/payments/manager.ts');
    const sym = targets.find((t) => t.kind === 'symbol' && t.value === 'RefundManager');
    expect(sym).toBeDefined();
    expect(sym?.action).toBe('create');
  });

  it('suppresses prose words that tokenize to nothing', () => {
    const plan = 'Create the New Feature and Update the System.';
    expect(parsePlan(plan).filter((t) => t.kind === 'symbol')).toEqual([]);
  });
});

describe('parsePlan — merge + action', () => {
  it('dedupes a path appearing in both structured and prose, keeping high confidence', () => {
    const plan = [
      'First we touch `src/payments/refund.service.ts`.',
      '',
      '## Files to Modify',
      '- `src/payments/refund.service.ts`',
    ].join('\n');
    const hits = parsePlan(plan).filter((t) => t.kind === 'file' && t.value === 'src/payments/refund.service.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0].confidence).toBe('high');
    expect(hits[0].action).toBe('modify');
  });

  it('infers modify when a modify verb is present', () => {
    const targets = parsePlan('We will extend RefundService with a new branch.');
    expect(targets.find((t) => t.value === 'RefundService')?.action).toBe('modify');
  });
});
