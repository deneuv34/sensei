import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { renderClaude } from '../src/exporters/claude.js';
import { renderCodex } from '../src/exporters/codex.js';
import { renderCursor } from '../src/exporters/cursor.js';
import { writeManagedSection, SECTION_START, SECTION_END } from '../src/exporters/write-section.js';
import { runExport } from '../src/core/run-export.js';
import { candidatesJsonPath, cursorRulePath, codexRulePath } from '../src/paths.js';
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

describe('writeManagedSection', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ws-'));
  });

  it('creates the file (and parent dirs) when absent', () => {
    const file = path.join(dir, 'nested', 'deep', 'AGENTS.md');
    writeManagedSection(file, 'BODY');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${SECTION_START}\nBODY\n${SECTION_END}\n`);
  });

  it('replaces the block in place and preserves surrounding content', () => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, `top\n${SECTION_START}\nOLD\n${SECTION_END}\nbottom\n`);
    writeManagedSection(file, 'NEW');
    expect(fs.readFileSync(file, 'utf8')).toBe(`top\n${SECTION_START}\nNEW\n${SECTION_END}\nbottom\n`);
  });

  it('is idempotent across re-runs with the same body', () => {
    const file = path.join(dir, 'AGENTS.md');
    writeManagedSection(file, 'BODY');
    const first = fs.readFileSync(file, 'utf8');
    writeManagedSection(file, 'BODY');
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('appends a block with one blank-line separator when no markers exist', () => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, 'user content\n');
    writeManagedSection(file, 'BODY');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `user content\n\n${SECTION_START}\nBODY\n${SECTION_END}\n`,
    );
  });
});

describe('runExport --write', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-re-'));
  });

  function seed(cwd: string) {
    const dest = candidatesJsonPath(cwd);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(report));
  }

  it('writes a whole dedicated MDC file for cursor', () => {
    seed(dir);
    const msg = runExport(dir, 'cursor', { write: true });
    const written = fs.readFileSync(cursorRulePath(dir), 'utf8');
    expect(msg).toContain('.cursor/rules/sensei.mdc');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toContain('- `src/auth/login.ts:2` login — login(email, password): boolean');
  });

  it('writes a managed section into AGENTS.md for codex, preserving user content', () => {
    seed(dir);
    fs.writeFileSync(codexRulePath(dir), '# My project\n');
    runExport(dir, 'codex', { write: true });
    const written = fs.readFileSync(codexRulePath(dir), 'utf8');
    expect(written.startsWith('# My project\n')).toBe(true);
    expect(written).toContain(SECTION_START);
    expect(written).toContain('## Reuse these (do not reimplement)');
  });

  it('refuses --write for claude', () => {
    seed(dir);
    expect(() => runExport(dir, 'claude', { write: true })).toThrow(/not supported/);
  });

  it('cursor --write is idempotent across re-runs', () => {
    seed(dir);
    runExport(dir, 'cursor', { write: true });
    const first = fs.readFileSync(cursorRulePath(dir), 'utf8');
    runExport(dir, 'cursor', { write: true });
    expect(fs.readFileSync(cursorRulePath(dir), 'utf8')).toBe(first);
  });

  it('without --write, cursor/codex return to stdout and touch no disk', () => {
    seed(dir);
    expect(runExport(dir, 'codex')).toBe(renderCodex(report));
    expect(fs.existsSync(codexRulePath(dir))).toBe(false);
  });
});
