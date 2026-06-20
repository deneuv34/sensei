import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';
import { candidatesJsonPath, contextMdPath } from '../src/paths.js';

let dir: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ctx-'));
  runInit(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'login.ts'),
    'export function login(email: string, password: string): boolean {\n  return Boolean(email && password);\n}\n',
  );
  await runScan(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runContext write option', () => {
  it('writes no report files when write is false', async () => {
    const report = await runContext(dir, 'add login', { write: false });
    expect(report.task).toBe('add login');
    expect(fs.existsSync(candidatesJsonPath(dir))).toBe(false);
    expect(fs.existsSync(contextMdPath(dir))).toBe(false);
  });

  it('writes report files by default', async () => {
    await runContext(dir, 'add login');
    expect(fs.existsSync(candidatesJsonPath(dir))).toBe(true);
    expect(fs.existsSync(contextMdPath(dir))).toBe(true);
  });
});
