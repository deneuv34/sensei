import { login } from './login.js';
import { describe, it, expect } from 'vitest';
describe('login', () => { it('works', () => { expect(login('a', 'b')).toBe(true); }); });
