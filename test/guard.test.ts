import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { installHook, uninstallHook } from '../src/guard/hook.js';

let work: string;

beforeEach(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-guard-'));
  await simpleGit(work).init();
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

describe('installHook', () => {
  it('writes a runnable, idempotent warn-only pre-commit hook', async () => {
    const file = await installHook(work, 'pre-commit', false);
    expect(file.endsWith(path.join('hooks', 'pre-commit'))).toBe(true);
    let content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith('#!/bin/sh')).toBe(true);
    expect(content).toContain('validate-diff --staged');
    expect(content).toContain('|| exit 0');
    expect(fs.statSync(file).mode & 0o111).toBeGreaterThan(0); // executable

    await installHook(work, 'pre-commit', false); // re-install
    content = fs.readFileSync(file, 'utf8');
    expect(content.match(/# >>> sensei guard >>>/g)).toHaveLength(1); // not duplicated
  });

  it('preserves existing hook content and supports blocking mode', async () => {
    const dir = path.join(work, '.git', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\necho custom\n');
    const file = await installHook(work, 'pre-commit', true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('echo custom');
    expect(content).toContain('validate-diff --staged --block');
    expect(content).not.toContain('|| exit 0');
  });

  it('throws outside a git repository', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ng-'));
    await expect(installHook(nonRepo, 'pre-commit', false)).rejects.toThrow(/Not a git repository/);
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});

describe('uninstallHook', () => {
  it('removes only the sensei block', async () => {
    const dir = path.join(work, '.git', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\necho custom\n');
    await installHook(work, 'pre-commit', false);
    expect(await uninstallHook(work, 'pre-commit')).toBe(true);
    const content = fs.readFileSync(path.join(dir, 'pre-commit'), 'utf8');
    expect(content).toContain('echo custom');
    expect(content).not.toContain('sensei guard');
    expect(await uninstallHook(work, 'pre-commit')).toBe(false); // nothing left to remove
  });
});
