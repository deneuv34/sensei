import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runValidateDiff } from '../src/core/run-validate-diff.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');
const FIXED = new Date('2026-06-16T00:00:00Z');
let work: string;

async function commitAll(dir: string, message: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.add('.');
  await git.commit(message);
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-vd-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('runValidateDiff (index-bound)', () => {
  it('flags a duplicate reimplementation and a dangerous entrypoint edit', async () => {
    fs.writeFileSync(
      path.join(work, 'src', 'auth', 'relogin.ts'),
      'export function login(email: string, password: string): boolean {\n  return Boolean(email) && Boolean(password);\n}\n',
    );
    fs.appendFileSync(path.join(work, 'src', 'index.ts'), '\n// touched\n');
    await simpleGit(work).add('.');

    const report = await runValidateDiff(work, { mode: 'staged' }, {}, FIXED);

    const dup = report.findings.find((f) => f.kind === 'duplicate-candidate');
    expect(dup?.file).toBe('src/auth/relogin.ts');
    expect(dup?.related?.path).toBe('src/auth/login.ts');

    const dang = report.findings.find((f) => f.kind === 'dangerous-edit');
    expect(dang?.file).toBe('src/index.ts');

    expect(report.blocked).toBe(false); // warn-only default
  });

  it('sets blocked=true under --block', async () => {
    const report = await runValidateDiff(work, { mode: 'staged' }, { block: true }, FIXED);
    expect(report.blocked).toBe(true);
  });

  it('errors clearly when no index exists', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-noidx-'));
    await simpleGit(fresh).init();
    await expect(runValidateDiff(fresh, { mode: 'staged' })).rejects.toThrow(/Run `sensei scan` first/);
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});
