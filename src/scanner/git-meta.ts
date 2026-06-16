// src/scanner/git-meta.ts
import { simpleGit } from 'simple-git';

export interface GitMeta {
  /** unix seconds of the newest commit touching the path */
  lastModified: number;
  /** number of commits touching the path */
  commitCount: number;
}

const COMMIT_MARKER = '__C__';

/** Pure parser over `git log --name-only --format=__C__%ct` stdout. */
export function parseGitLog(stdout: string): Map<string, GitMeta> {
  const map = new Map<string, GitMeta>();
  let currentTime: number | null = null;

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith(COMMIT_MARKER)) {
      const ts = Number(line.slice(COMMIT_MARKER.length));
      currentTime = Number.isFinite(ts) ? ts : null;
      continue;
    }

    if (currentTime === null) continue; // file line with no commit header: ignore

    const existing = map.get(line);
    if (existing) {
      existing.commitCount += 1; // log is newest-first, so lastModified already correct
    } else {
      map.set(line, { lastModified: currentTime, commitCount: 1 });
    }
  }

  return map;
}

/**
 * Run a single `git log` over the whole repo and parse it.
 * Returns an empty map when not a git repo or git fails — callers fall back to defaults.
 */
export async function gitMetaMap(cwd: string): Promise<Map<string, GitMeta>> {
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) return new Map();
  try {
    const stdout = await git.raw(['log', '--name-only', `--format=${COMMIT_MARKER}%ct`]);
    return parseGitLog(stdout);
  } catch {
    return new Map();
  }
}
