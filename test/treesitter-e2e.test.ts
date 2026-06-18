import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runValidateDiff } from '../src/core/run-validate-diff.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'multilang-repo');
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
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ml-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('multi-language reuse detection (e2e)', () => {
  it('indexes Python symbols during scan', async () => {
    const result = await runScan(work);
    expect(result.symbolCount).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it('flags a duplicate Python reimplementation against the index', async () => {
    fs.writeFileSync(
      path.join(work, 'src', 'money.py'),
      'def format_currency(amount, currency):\n    return str(currency) + str(amount)\n',
    );
    await simpleGit(work).add('.');

    const report = await runValidateDiff(work, { mode: 'staged' }, {}, FIXED);
    const dup = report.findings.find((f) => f.kind === 'duplicate-candidate' && f.file === 'src/money.py');
    expect(dup).toBeTruthy();
    expect(dup?.related?.path).toBe('src/util.py');
  });
});
