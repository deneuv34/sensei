import { describe, it, expect } from 'vitest';
import { buildReport, renderMarkdown } from '../src/report/build.js';
import { ContextReportSchema } from '../src/report/schema.js';
import type { ReuseCandidate, DangerousFile } from '../src/types.js';

const candidates: ReuseCandidate[] = [
  { path: 'src/auth/login.ts', line: 2, name: 'login', kind: 'function', signature: 'login(email: string, password: string): boolean', score: 0.85, reasons: ['exported (public API)'] },
];
const dangerous: DangerousFile[] = [
  { path: 'src/auth/login.ts', importerCount: 3, reason: '3 files import this' },
];

describe('report', () => {
  it('builds a schema-valid report with a fixed timestamp', () => {
    const report = buildReport('add password reset', candidates, dangerous, ['Reuse existing code'], new Date('2026-06-16T00:00:00Z'));
    expect(() => ContextReportSchema.parse(report)).not.toThrow();
    expect(report.task).toBe('add password reset');
    expect(report.generatedAt).toBe('2026-06-16T00:00:00.000Z');
  });

  it('renders markdown with reuse candidates and dangerous files', () => {
    const report = buildReport('add password reset', candidates, dangerous, ['Reuse existing code'], new Date('2026-06-16T00:00:00Z'));
    const md = renderMarkdown(report);
    expect(md).toContain('# Sensei Context');
    expect(md).toContain('src/auth/login.ts:2');
    expect(md).toContain('login(email: string, password: string)');
    expect(md).toContain('Do not casually edit');
    expect(md).toContain('Reuse existing code');
  });
});
