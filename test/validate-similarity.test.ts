import { describe, it, expect } from 'vitest';
import { symbolSimilarity, nameContainment } from '../src/validate/similarity.js';

describe('symbolSimilarity (unchanged 50/50)', () => {
  it('is 1.0 for identical name and signature', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(email: string): boolean' },
      { name: 'login', signature: 'login(email: string): boolean' },
    )).toBeCloseTo(1, 5);
  });

  it('caps a name-only match at 0.5', () => {
    expect(symbolSimilarity(
      { name: 'login', signature: 'login(): void' },
      { name: 'login', signature: 'other(a: Foo, b: Bar): Baz' },
    )).toBeLessThanOrEqual(0.5);
  });
});

describe('nameContainment', () => {
  it('is 1.0 when the proposed name contains all of an existing multi-token name', () => {
    expect(nameContainment('PartialRefundService', 'RefundService')).toBeCloseTo(1, 5);
  });

  it('is below threshold for a single shared token of a multi-token name', () => {
    expect(nameContainment('PaymentService', 'RefundService')).toBeCloseTo(0.5, 5);
  });

  it('returns 0 for a single-token existing name unless matched exactly', () => {
    expect(nameContainment('validatePlan', 'validate')).toBe(0);
    expect(nameContainment('validate', 'validate')).toBe(1);
  });

  it('returns 0 when either side tokenizes to nothing', () => {
    expect(nameContainment('x', 'RefundService')).toBe(0);
    expect(nameContainment('RefundService', 'a')).toBe(0);
  });
});
