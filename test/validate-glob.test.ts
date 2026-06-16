import { describe, it, expect } from 'vitest';
import { firstDangerousMatch } from '../src/validate/glob.js';

describe('firstDangerousMatch', () => {
  it('returns the matching glob for a path under it', () => {
    expect(firstDangerousMatch('src/auth/login.ts', ['src/auth/**'])).toBe('src/auth/**');
  });

  it('returns null when nothing matches', () => {
    expect(firstDangerousMatch('src/util/x.ts', ['src/auth/**', 'prisma/**'])).toBeNull();
  });

  it('returns null for an empty pattern list', () => {
    expect(firstDangerousMatch('src/auth/login.ts', [])).toBeNull();
  });

  it('matches a bare filename glob', () => {
    expect(firstDangerousMatch('package.json', ['package.json'])).toBe('package.json');
  });

  it('reports the first matching pattern when several match', () => {
    expect(firstDangerousMatch('src/auth/login.ts', ['src/**', 'src/auth/**'])).toBe('src/**');
  });
});
