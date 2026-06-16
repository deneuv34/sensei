import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/ast/extract.js';

const SRC = `
import { login } from '../auth/login.js';
import Default from 'pkg';
import './side-effect.js';
import * as ns from 'nspkg';

/** Authenticate. */
export function authenticate(user: string, pass: string): boolean {
  return login(user, pass);
}

export class Session {
  start(): void {}
}

export default function bootstrap(): void {}

export const makeId = (): string => 'x';

const internalHelper = 1;
export const TOKEN_TTL = 3600;
`;

describe('extractFromSource', () => {
  it('extracts exported functions with signature, jsdoc, and line', () => {
    const { symbols } = extractFromSource('src/user/auth.ts', SRC);
    const fn = symbols.find((s) => s.name === 'authenticate')!;
    expect(fn.kind).toBe('function');
    expect(fn.exported).toBe(true);
    expect(fn.signature).toContain('authenticate(user: string, pass: string)');
    expect(fn.jsdoc).toContain('Authenticate');
    expect(fn.startLine).toBeGreaterThan(0);
  });

  it('extracts classes and their methods', () => {
    const { symbols } = extractFromSource('src/user/auth.ts', SRC);
    expect(symbols.find((s) => s.name === 'Session' && s.kind === 'class')).toBeTruthy();
    expect(symbols.find((s) => s.name === 'Session.start' && s.kind === 'method')).toBeTruthy();
  });

  it('marks export state on top-level const declarations', () => {
    const { symbols } = extractFromSource('src/user/auth.ts', SRC);
    expect(symbols.find((s) => s.name === 'TOKEN_TTL')!.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'internalHelper')!.exported).toBe(false);
  });

  it('extracts imports with module specifier and imported names', () => {
    const { imports } = extractFromSource('src/user/auth.ts', SRC);
    expect(imports).toContainEqual({ module: '../auth/login.js', importedName: 'login' });
    expect(imports).toContainEqual({ module: 'pkg', importedName: 'default' });
  });

  it('extracts arrow-function consts as const symbols', () => {
    const { symbols } = extractFromSource('src/user/auth.ts', SRC);
    const makeId = symbols.find((s) => s.name === 'makeId')!;
    expect(makeId.kind).toBe('const');
    expect(makeId.exported).toBe(true);
  });

  it('marks default-exported declarations as exported', () => {
    const { symbols } = extractFromSource('src/user/auth.ts', SRC);
    expect(symbols.find((s) => s.name === 'bootstrap')!.exported).toBe(true);
  });

  it('captures side-effect and namespace imports', () => {
    const { imports } = extractFromSource('src/user/auth.ts', SRC);
    expect(imports).toContainEqual({ module: './side-effect.js', importedName: '' });
    expect(imports).toContainEqual({ module: 'nspkg', importedName: '*' });
  });
});
