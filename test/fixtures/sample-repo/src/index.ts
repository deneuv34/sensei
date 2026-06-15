import { login } from './auth/login.js';
import { UserProfile } from './user/profile.js';

export function main(): void {
  const ok = login('a@b.com', 'pw');
  void new UserProfile('a@b.com');
  void ok;
}
