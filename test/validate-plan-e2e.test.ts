import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runValidatePlan } from '../src/core/run-validate-plan.js';
import { configPath } from '../src/paths.js';

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
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-vp-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  // enable a dangerous-path glob over the auth dir
  fs.writeFileSync(configPath(work), JSON.stringify({ dangerous: { paths: ['src/auth/**'] } }, null, 2));
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('runValidatePlan (e2e on fixture)', () => {
  it('flags a reuse-candidate that duplicates an existing fixture symbol', async () => {
    const plan = ['## New Symbols', '- `UserProfileManager`'].join('\n');
    const report = await runValidatePlan(work, plan, {}, FIXED);
    const reuse = report.findings.find((f) => f.kind === 'reuse-candidate');
    expect(reuse?.file).toBe('UserProfileManager');
    expect(reuse?.related?.path).toBe('src/user/profile.ts');
    expect(report.blocked).toBe(false);
  });

  it('flags a proposed NEW file under the dangerous glob (not yet indexed)', async () => {
    const plan = ['## Files to Create', '- `src/auth/oauth.ts`'].join('\n');
    const report = await runValidatePlan(work, plan, {}, FIXED);
    expect(report.findings.find((f) => f.kind === 'dangerous-target')?.file).toBe('src/auth/oauth.ts');
  });

  it('returns no findings for a clean, unrelated plan', async () => {
    const plan = ['## Files to Modify', '- `src/util/strings.ts`', '', 'Tweak helper formatting.'].join('\n');
    const report = await runValidatePlan(work, plan, {}, FIXED);
    expect(report.findings).toEqual([]);
  });

  it('sets blocked=true under block for a plan with findings', async () => {
    const plan = '## New Symbols\n- `UserProfileManager`';
    const report = await runValidatePlan(work, plan, { block: true }, FIXED);
    expect(report.blocked).toBe(true);
  });

  it('is deterministic: same plan + index → identical findings', async () => {
    const plan = '## New Symbols\n- `UserProfileManager`';
    const a = await runValidatePlan(work, plan, {}, FIXED);
    const b = await runValidatePlan(work, plan, {}, FIXED);
    expect(b.findings).toEqual(a.findings);
  });
});
