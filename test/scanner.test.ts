import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../src/scanner/scan.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('scanRepo', () => {
  it('finds ts files, respects .gitignore, returns sorted posix paths with hashes', async () => {
    const files = await scanRepo(repo, DEFAULT_CONFIG);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/auth/login.ts');
    expect(paths).toContain('src/user/profile.ts');
    expect(paths).not.toContain('ignored-dir/skip.ts'); // .gitignore respected
    expect(paths).toEqual([...paths].sort());            // deterministic order
    const login = files.find((f) => f.path === 'src/auth/login.ts')!;
    expect(login.lang).toBe('ts');
    expect(login.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(login.loc).toBeGreaterThan(0);
  });
});
