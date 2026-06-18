import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const LANGS = ['python', 'go', 'rust', 'java'];
const dest = path.resolve('vendor/tree-sitter');
mkdirSync(dest, { recursive: true });

for (const lang of LANGS) {
  const file = `tree-sitter-${lang}.wasm`;
  const src = require.resolve(`tree-sitter-wasms/out/${file}`);
  copyFileSync(src, path.join(dest, file));
  console.log(`vendored ${file}`);
}
