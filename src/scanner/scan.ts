import fg from 'fast-glob';
import { createRequire } from 'node:module';
import type { Ignore } from 'ignore';
import { simpleGit } from 'simple-git';

// `ignore` ships CJS (module.exports = factory) with a .d.ts that NodeNext types as a
// non-callable default. Load it via createRequire so the runtime value is the real factory.
const require = createRequire(import.meta.url);
const createIgnore = require('ignore') as (options?: object) => Ignore;
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ScannedFile, Lang } from '../types.js';
import type { SenseiConfig } from '../config/schema.js';

function extLang(rel: string): Lang {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.ts')) return 'ts';
  if (rel.endsWith('.jsx')) return 'jsx';
  return 'js';
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

export async function scanRepo(cwd: string, config: SenseiConfig): Promise<ScannedFile[]> {
  const entries = await fg(config.include, {
    cwd,
    ignore: config.ignore,
    onlyFiles: true,
    dot: false,
  });

  const ig = createIgnore();
  const giPath = path.join(cwd, '.gitignore');
  if (fs.existsSync(giPath)) ig.add(fs.readFileSync(giPath, 'utf8'));
  const kept = entries.filter((p) => !ig.ignores(p)).sort();

  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);

  const files: ScannedFile[] = [];
  for (const rel of kept) {
    const abs = path.join(cwd, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable file: skip
    }
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    const loc = content.length === 0 ? 0 : content.split('\n').length;

    let gitLastModified: number | null = null;
    let gitCommitCount = 0;
    if (isRepo) {
      try {
        const log = await git.log({ file: rel });
        gitCommitCount = log.total;
        if (log.latest) gitLastModified = Math.floor(new Date(log.latest.date).getTime() / 1000);
      } catch {
        // file not tracked yet: leave git fields at defaults
      }
    }

    files.push({ path: toPosix(rel), hash, lang: extLang(rel), loc, gitLastModified, gitCommitCount });
  }
  return files;
}
