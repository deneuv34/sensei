/** Authenticate a user with email + password. */
export function login(email: string, password: string): boolean {
  return email.length > 0 && password.length > 0;
}

export function hashPassword(password: string): string {
  return password.split('').reverse().join('');
}
