import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import { ConfigSchema, DEFAULT_CONFIG } from '../src/config/schema.js';
import { runPlanChecks } from '../src/validate/plan-checks.js';
import type { ProposedTarget } from '../src/validate/plan-parse.js';
import type { ExtractedSymbol } from '../src/types.js';

const sym = (name: string, signature: string, startLine = 1): ExtractedSymbol =>
  ({ kind: 'class', name, signature, exported: true, startLine, jsdoc: '' });

function seedRefund(): IndexDb {
  const db = new IndexDb(':memory:');
  db.migrate();
  const id = db.upsertFile({ path: 'src/payments/refund.service.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0 });
  db.insertSymbol(id, sym('RefundService', 'class RefundService', 2), 'src/payments/refund.service.ts');
  return db;
}

const target = (over: Partial<ProposedTarget>): ProposedTarget =>
  ({ kind: 'symbol', value: 'X', action: 'create', line: 1, confidence: 'high', ...over });

describe('reuse-candidate check', () => {
  it('flags a create symbol that contains an existing multi-token symbol', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'PartialRefundService', line: 5 })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    const f = out.find((x) => x.kind === 'reuse-candidate');
    expect(f?.file).toBe('PartialRefundService');
    expect(f?.line).toBe(5);
    expect(f?.related?.path).toBe('src/payments/refund.service.ts');
    db.close();
  });

  it('does not flag a modify-action symbol', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'PartialRefundService', action: 'modify' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });

  it('does not flag an unrelated create symbol', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'InvoiceMailer' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });

  it('flags a create file whose basename contains an existing file basename', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/payments/refund-v2.service.ts' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    const f = out.find((x) => x.kind === 'reuse-candidate');
    expect(f?.related?.path).toBe('src/payments/refund.service.ts');
    db.close();
  });

  it('suppresses a target that tokenizes to nothing', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ value: 'x' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });
});

describe('dangerous-target check', () => {
  it('flags a proposed NEW file under a dangerous.paths glob even when not indexed', () => {
    const db = seedRefund();
    const config = ConfigSchema.parse({ dangerous: { paths: ['src/auth/**'] } });
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/auth/oauth.ts', line: 9 })], db, config, severity: 'warn' });
    const f = out.find((x) => x.kind === 'dangerous-target');
    expect(f?.file).toBe('src/auth/oauth.ts');
    expect(f?.line).toBe(9);
    db.close();
  });

  it('flags a proposed entrypoint file via the index map', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile({ path: 'src/index.ts', hash: 'h', lang: 'ts', loc: 2, gitLastModified: null, gitCommitCount: 0 });
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/index.ts' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'dangerous-target')?.file).toBe('src/index.ts');
    db.close();
  });

  it('does not flag an ordinary proposed file', () => {
    const db = seedRefund();
    const out = runPlanChecks({ targets: [target({ kind: 'file', value: 'src/util/x.ts' })], db, config: DEFAULT_CONFIG, severity: 'warn' });
    expect(out.find((x) => x.kind === 'dangerous-target')).toBeUndefined();
    db.close();
  });
});

describe('registry gating', () => {
  it('skips reuse when checkDuplicates is false', () => {
    const db = seedRefund();
    const config = ConfigSchema.parse({ validate: { checkDuplicates: false } });
    const out = runPlanChecks({ targets: [target({ value: 'PartialRefundService' })], db, config, severity: 'warn' });
    expect(out.find((x) => x.kind === 'reuse-candidate')).toBeUndefined();
    db.close();
  });
});
