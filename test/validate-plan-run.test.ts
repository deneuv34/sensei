import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexDb } from '../src/indexer/db.js';
import { runInit } from '../src/core/run-init.js';
import { runValidatePlan } from '../src/core/run-validate-plan.js';
import type { ExtractedSymbol } from '../src/types.js';
import { dbPath } from '../src/paths.js';

const sym = (name: string, signature: string, startLine = 1): ExtractedSymbol =>
  ({ kind: 'class', name, signature, exported: true, startLine, jsdoc: '' });

let work: string | undefined;
afterEach(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); work = undefined; });

function seed(dir: string): void {
  runInit(dir);
  const db = new IndexDb(dbPath(dir));
  db.migrate();
  const id = db.upsertFile({ path: 'src/payments/refund.service.ts', hash: 'h', lang: 'ts', loc: 4, gitLastModified: null, gitCommitCount: 0 });
  db.insertSymbol(id, sym('RefundService', 'class RefundService', 2), 'src/payments/refund.service.ts');
  db.close();
}

describe('runValidatePlan', () => {
  it('throws a clear error when no index exists', async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-plan-noidx-'));
    await expect(runValidatePlan(work, '## New Symbols\n- `Foo`')).rejects.toThrow(/Run `sensei scan` first/);
  });

  it('produces a reuse-candidate and sets blocked under block', async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-plan-run-'));
    seed(work);
    const text = '## New Symbols\n- `PartialRefundService`';
    const warn = await runValidatePlan(work, text);
    expect(warn.findings.some((f) => f.kind === 'reuse-candidate')).toBe(true);
    expect(warn.blocked).toBe(false);
    const blocked = await runValidatePlan(work, text, { block: true });
    expect(blocked.blocked).toBe(true);
  });
});
