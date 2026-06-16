import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export type HookName = 'pre-commit' | 'pre-push';

const BEGIN = '# >>> sensei guard >>>';
const END = '# <<< sensei guard <<<';
const SHEBANG = '#!/bin/sh';

async function hooksDir(cwd: string): Promise<string> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) throw new Error('Not a git repository.');
  const rel = (await git.raw(['rev-parse', '--git-path', 'hooks'])).trim();
  return path.isAbsolute(rel) ? rel : path.join(cwd, rel);
}

function senseiInvocation(cwd: string): string {
  const local = path.join(cwd, 'node_modules', '.bin', 'sensei');
  return fs.existsSync(local) ? local : 'sensei';
}

function managedBlock(cwd: string, hook: HookName, block: boolean): string {
  const inv = senseiInvocation(cwd);
  const cmd = hook === 'pre-push'
    ? `${inv} validate-diff --against @{upstream}`
    : `${inv} validate-diff --staged`;
  const line = block ? `${cmd} --block` : `${cmd} || exit 0`;
  return [BEGIN, line, END].join('\n');
}

function stripBlock(content: string): string {
  const lines = content.split('\n');
  const start = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (start === -1 || end === -1 || end < start) return content;
  lines.splice(start, end - start + 1);
  if (lines[start] === '' && (start === 0 || lines[start - 1] === '')) lines.splice(start, 1);
  return lines.join('\n');
}

export async function installHook(cwd: string, hook: HookName, block: boolean): Promise<string> {
  const dir = await hooksDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, hook);
  const exists = fs.existsSync(file);
  const base = exists ? stripBlock(fs.readFileSync(file, 'utf8')) : `${SHEBANG}\n`;
  const sep = base.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${base}${sep}${managedBlock(cwd, hook, block)}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

export async function uninstallHook(cwd: string, hook: HookName): Promise<boolean> {
  const dir = await hooksDir(cwd);
  const file = path.join(dir, hook);
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, 'utf8');
  if (!current.includes(BEGIN)) return false;
  fs.writeFileSync(file, stripBlock(current));
  return true;
}
