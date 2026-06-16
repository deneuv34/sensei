import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { changedFiles } from '../src/validate/diff.js';

let work: string;

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-diff-'));
  const git = simpleGit(work);
  await git.init();
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# readme\n');
  await git.add('.');
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('changedFiles', () => {
  it('returns only supported, sorted, posix paths from the staged set', async () => {
    const files = await changedFiles(work, { mode: 'staged' });
    expect(files).toEqual(['src/a.ts']); // README.md filtered out
  });

  it('throws outside a git repository', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-norepo-'));
    await expect(changedFiles(nonRepo, { mode: 'staged' })).rejects.toThrow(/Not a git repository/);
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });
});
