import { login } from '../auth/login.js';

export class UserProfile {
  constructor(public email: string) {}
  canLogin(password: string): boolean {
    return login(this.email, password);
  }
}
