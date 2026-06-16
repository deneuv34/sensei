// test/git-meta.test.ts
import { describe, it, expect } from 'vitest';
import { parseGitLog } from '../src/scanner/git-meta.js';

// Format produced by: git log --name-only --format=__C__%ct
// Newest commit first. Header line marks a commit + its committer timestamp.
const STDOUT = [
  '__C__1700000300',
  'src/auth/login.ts',
  'src/user/profile.ts',
  '',
  '__C__1700000200',
  'src/auth/login.ts',
  '',
  '__C__1700000100',
  'src/user/profile.ts',
  '',
].join('\n');

describe('parseGitLog', () => {
  it('maps each path to its newest commit time and total commit count', () => {
    const map = parseGitLog(STDOUT);
    expect(map.get('src/auth/login.ts')).toEqual({ lastModified: 1700000300, commitCount: 2 });
    expect(map.get('src/user/profile.ts')).toEqual({ lastModified: 1700000300, commitCount: 2 });
  });

  it('returns an empty map for empty stdout', () => {
    expect(parseGitLog('').size).toBe(0);
    expect(parseGitLog('\n\n').size).toBe(0);
  });

  it('ignores file lines with no preceding commit header', () => {
    const map = parseGitLog('orphan.ts\n__C__1700000100\nreal.ts\n');
    expect(map.has('orphan.ts')).toBe(false);
    expect(map.get('real.ts')).toEqual({ lastModified: 1700000100, commitCount: 1 });
  });
});
