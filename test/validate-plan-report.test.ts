import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ValidationReportSchema,
  renderValidation,
  writePlanValidation,
  type ValidationReport,
} from '../src/validate/report.js';
import { lastPlanValidationJsonPath, lastValidationJsonPath } from '../src/paths.js';

const report: ValidationReport = {
  source: 'plan',
  generatedAt: '2026-06-16T00:00:00.000Z',
  findings: [
    { kind: 'reuse-candidate', severity: 'warn', file: 'PartialRefundService', line: 5,
      message: 'extend RefundService instead', related: { path: 'src/refund.ts', line: 2, name: 'RefundService', score: 1 } },
    { kind: 'dangerous-target', severity: 'warn', file: 'src/auth/oauth.ts', line: 9,
      message: 'matches dangerous path' },
  ],
  blocked: false,
};

let work: string | undefined;
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); work = undefined; });

describe('plan report', () => {
  it('accepts the new finding kinds and source plan', () => {
    expect(() => ValidationReportSchema.parse(report)).not.toThrow();
  });

  it('renders REUSE CANDIDATES then DANGEROUS TARGETS groups', () => {
    const out = renderValidation(report);
    expect(out.indexOf('REUSE CANDIDATES')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('DANGEROUS TARGETS')).toBeGreaterThan(out.indexOf('REUSE CANDIDATES'));
  });

  it('writes the separate plan report file without touching last-validation.json', () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-plan-report-'));
    writePlanValidation(work, report);
    expect(fs.existsSync(lastPlanValidationJsonPath(work))).toBe(true);
    expect(fs.existsSync(lastValidationJsonPath(work))).toBe(false);
  });
});
