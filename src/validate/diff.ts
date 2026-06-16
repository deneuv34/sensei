import { simpleGit } from 'simple-git';

export type DiffSource =
  | { mode: 'staged' }
  | { mode: 'all' }
  | { mode: 'against'; ref: string };

const SUPPORTED = /\.(ts|tsx|js|jsx)$/;
const NAME_ONLY = ['--name-only', '--diff-filter=ACMR'];

export async function changedFiles(cwd: string, source: DiffSource): Promise<string[]> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) throw new Error('Not a git repository.');

  let out: string;
  if (source.mode === 'staged') out = await git.diff(['--cached', ...NAME_ONLY]);
  else if (source.mode === 'all') out = await git.diff([...NAME_ONLY, 'HEAD']);
  else out = await git.diff([...NAME_ONLY, `${source.ref}...HEAD`]);

  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && SUPPORTED.test(l))
    .sort();
}
