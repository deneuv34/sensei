import { describe, it, expect } from 'vitest';
import { renderClaude } from '../src/exporters/claude.js';
import { renderCodex } from '../src/exporters/codex.js';
import { renderCursor } from '../src/exporters/cursor.js';
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

const emptyReport: ContextReport = {
  task: 'small tweak',
  generatedAt: '2026-06-16T00:00:00.000Z',
  reuseCandidates: [],
  dangerousFiles: [],
  agentRules: ['Prefer reuse'],
};

describe('renderCodex', () => {
  it('renders markdown body with candidates and dangerous files', () => {
    expect(renderCodex(report)).toBe(
      [
        '# Sensei context for: add password reset',
        '',
        '## Reuse these (do not reimplement)',
        '- `src/auth/login.ts:2` login — login(email, password): boolean',
        '',
        '## Do not touch without confirmation (high-impact files)',
        '- `src/auth/login.ts` (3 files import this)',
        '',
        '## Rules',
        '- Reuse existing code',
      ].join('\n'),
    );
  });

  it('renders empty-state placeholders when there are no candidates', () => {
    expect(renderCodex(emptyReport)).toBe(
      [
        '# Sensei context for: small tweak',
        '',
        '## Reuse these (do not reimplement)',
        '- (no strong matches found)',
        '',
        '## Do not touch without confirmation (high-impact files)',
        '- (none detected)',
        '',
        '## Rules',
        '- Prefer reuse',
      ].join('\n'),
    );
  });
});

describe('renderCursor', () => {
  it('prefixes MDC frontmatter then the shared markdown body', () => {
    const out = renderCursor(report);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('alwaysApply: true');
    expect(out).toContain(renderCodex(report));
    // frontmatter must precede the body so Cursor can parse it
    expect(out.indexOf('alwaysApply: true')).toBeLessThan(out.indexOf('## Reuse these'));
  });
});
