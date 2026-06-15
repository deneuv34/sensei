import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';
import { runExport } from '../src/core/run-export.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');
let work: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-e2e-'));
  fs.cpSync(fixture, work, { recursive: true });
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('end-to-end: init -> scan -> context -> export', () => {
  it('produces a ranked, deterministic report and a Claude export', async () => {
    runInit(work);
    expect(fs.existsSync(path.join(work, '.sensei', 'sensei.config.json'))).toBe(true);
    expect(fs.existsSync(path.join(work, '.sensei', 'agent-rules.md'))).toBe(true);

    const scan = await runScan(work);
    expect(scan.symbolCount).toBeGreaterThan(0);

    const report = await runContext(work, 'add login with password', new Date('2026-06-16T00:00:00Z'));
    expect(report.reuseCandidates[0].name).toBe('login');
    expect(report.reuseCandidates.length).toBeLessThanOrEqual(10);
    expect(fs.existsSync(path.join(work, '.sensei', 'current-task-context.md'))).toBe(true);
    expect(fs.existsSync(path.join(work, '.sensei', 'reuse-candidates.json'))).toBe(true);

    // determinism: re-run yields identical ranking
    const again = await runContext(work, 'add login with password', new Date('2026-06-16T00:00:00Z'));
    expect(again.reuseCandidates.map((c) => c.name)).toEqual(report.reuseCandidates.map((c) => c.name));

    const exported = runExport(work, 'claude');
    expect(exported).toContain('REUSE THESE');
    expect(exported).toContain('login');

    expect(() => runExport(work, 'cursor')).toThrow(/not implemented yet/);
  });

  it('context errors clearly before a scan exists', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-fresh-'));
    await expect(runContext(fresh, 'anything')).rejects.toThrow(/Run `sensei scan` first/);
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});
