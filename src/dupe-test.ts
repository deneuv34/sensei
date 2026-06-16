// TEMP: prove Sensei reuse detection in CI. Reverted after the test.
// Re-declares `changedFiles`, which already exists in src/validate/diff.ts.
export async function changedFiles(cwd: string): Promise<string[]> {
  return [cwd];
}
