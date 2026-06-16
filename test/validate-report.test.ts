import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ValidationReportSchema,
  renderValidation,
  writeValidation,
  type ValidationReport,
} from '../src/validate/report.js';
import { lastValidationJsonPath } from '../src/paths.js';

const report: ValidationReport = {
  source: 'staged',
  generatedAt: '2026-06-16T00:00:00.000Z',
  findings: [
    {
      kind: 'duplicate-candidate', severity: 'warn', file: 'src/new.ts', line: 2,
      message: 'login closely matches existing login at src/auth/login.ts:2 (similarity 1.00) — reuse instead of reimplementing.',
      related: { path: 'src/auth/login.ts', line: 2, name: 'login', score: 1 },
    },
    {
      kind: 'dangerous-edit', severity: 'warn', file: 'src/index.ts', line: 1,
      message: 'editing src/index.ts — entrypoint file (importer_count 0).',
    },
  ],
  blocked: false,
};

describe('validation report', () => {
  it('round-trips through the Zod schema', () => {
    expect(() => ValidationReportSchema.parse(report)).not.toThrow();
  });

  it('renders grouped human output', () => {
    const text = renderValidation(report);
    expect(text).toContain('DUPLICATE CANDIDATES:');
    expect(text).toContain('DANGEROUS EDITS:');
    expect(text).toContain('src/new.ts:2');
  });

  it('renders a clean run as "No findings."', () => {
    expect(renderValidation({ ...report, findings: [] })).toBe('No findings.');
  });

  it('writes last-validation.json', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-vr-'));
    writeValidation(work, report);
    const written = JSON.parse(fs.readFileSync(lastValidationJsonPath(work), 'utf8'));
    expect(written.findings).toHaveLength(2);
    fs.rmSync(work, { recursive: true, force: true });
  });
});
