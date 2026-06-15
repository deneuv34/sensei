import { describe, it, expect } from 'vitest';
import { renderClaude } from '../src/exporters/claude.js';
import type { ContextReport } from '../src/types.js';

const report: ContextReport = {
  task: 'add password reset',
  generatedAt: '2026-06-16T00:00:00.000Z',
  reuseCandidates: [
    { path: 'src/auth/login.ts', line: 2, name: 'login', kind: 'function', signature: 'login(email, password): boolean', score: 0.85, reasons: ['exported'] },
  ],
  dangerousFiles: [{ path: 'src/auth/login.ts', importerCount: 3, reason: '3 files import this' }],
  agentRules: ['Reuse existing code'],
};

describe('renderClaude', () => {
  it('renders a Claude-ready block leading with reuse and do-not-touch', () => {
    const out = renderClaude(report);
    expect(out).toContain('SENSEI CONTEXT');
    expect(out).toContain('add password reset');
    expect(out).toContain('REUSE THESE');
    expect(out).toContain('src/auth/login.ts:2');
    expect(out).toContain('DO NOT TOUCH');
    expect(out.indexOf('REUSE THESE')).toBeLessThan(out.indexOf('DO NOT TOUCH'));
  });
});
