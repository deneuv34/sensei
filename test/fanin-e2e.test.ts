import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';
import { runValidateDiff } from '../src/core/run-validate-diff.js';
import { configPath } from '../src/paths.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fanin-repo');
const FIXED = new Date('2026-06-26T00:00:00Z');
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
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-fanin-'));
  fs.cpSync(fixture, work, { recursive: true });
  runInit(work);
  // The default dangerous.importerThreshold is 5, which requires 5 importers to flag
  // a file. This fixture is intentionally small (2 Python importers, 1 Go package
  // importer) to exercise the extract→resolve→clone→recompute→flag flow without
  // contrived fan-out. Lower the threshold to 1 so a file with any importers is
  // flagged, while the assertions still verify the exact importer counts.
  const cfgPath = configPath(work);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.dangerous.importerThreshold = 1;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  await commitAll(work, 'baseline');
  await runScan(work);
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('cross-language fan-in (e2e)', () => {
  it('flags util.py as dangerous (2 importers) in context', async () => {
    const report = await runContext(work, 'format some money', { write: false });
    const util = report.dangerousFiles.find((d) => d.path === 'util.py');
    expect(util).toBeTruthy();
    expect(util!.importerCount).toBeGreaterThanOrEqual(2);
  });

  it('flags a dangerous edit to util.py via validate-diff', async () => {
    fs.writeFileSync(path.join(work, 'util.py'), 'def format_currency(a, c):\n    return ""\n');
    await simpleGit(work).add('.');
    const report = await runValidateDiff(work, { mode: 'staged' }, {}, FIXED);
    const danger = report.findings.find((f) => f.kind === 'dangerous-edit' && f.file === 'util.py');
    expect(danger).toBeTruthy();
  });

  it('flags the Go auth package files as dangerous (1 package importer)', async () => {
    const report = await runContext(work, 'authenticate a user', { write: false });
    const auth = report.dangerousFiles.find((d) => d.path === 'internal/auth/auth.go');
    expect(auth).toBeTruthy();
    expect(auth!.importerCount).toBeGreaterThanOrEqual(1);
  });
});
