import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/text/tokenize.js';

describe('tokenize', () => {
  it('splits camelCase and snake_case, lowercases, dedupes', () => {
    expect(tokenize('passwordReset')).toEqual(['password', 'reset']);
    expect(tokenize('AuthService user_id')).toEqual(['auth', 'service', 'user', 'id']);
  });

  it('drops stopwords and short tokens', () => {
    expect(tokenize('Add a new feature to the AuthService')).toEqual(['auth', 'service']);
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});
