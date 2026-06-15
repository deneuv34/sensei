# Sensei MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Sensei thin vertical slice — a deterministic TS/JS CLI (`init`, `scan`, `context`, `export`) that scans a repo into a local SQLite symbol index and produces a ranked "what to reuse / what not to touch" context report.

**Architecture:** Single npm package, ESM, oclif commands in `src/commands/` as thin wrappers over a `src/core/` orchestration layer, which composes focused modules (`config`, `scanner`, `ast`, `indexer`, `search`, `scorer`, `report`, `exporters`). Storage is SQLite via `better-sqlite3` with an FTS5 index over symbols. No AI, fully deterministic.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22+, pnpm, oclif v4, ts-morph (AST), fast-glob + ignore + simple-git (scan), better-sqlite3 + SQLite FTS5 (storage), Zod (schemas), Vitest (tests), tsc (build).

**Build/deviation notes (from spec):** Uses `tsc` not `tsup` (oclif's documented ESM path; avoids bundler + native-module + command-discovery friction). Uses raw `better-sqlite3` not Drizzle (approved in spec). Drops unused `micromatch`. CLI commands live in `src/commands/` (oclif convention) rather than `src/cli/`. A `src/core/` orchestration layer and `src/text/`, `src/paths.ts` helpers are added for clean boundaries.

---

## File Structure

```
bin/run.js                      # oclif ESM entrypoint
package.json                    # deps + oclif config + scripts
tsconfig.json                   # NodeNext ESM
vitest.config.ts                # test config
.gitignore
src/
  types.ts                      # shared domain types (single source of truth)
  paths.ts                      # .sensei/* path helpers
  text/tokenize.ts              # identifier-aware tokenizer (shared by search + scorer)
  config/schema.ts              # Zod SenseiConfig schema + defaults
  config/load.ts                # loadConfig / writeDefaultConfig
  scanner/scan.ts               # scanRepo -> ScannedFile[]
  ast/extract.ts                # extractFromSource -> FileExtraction
  indexer/db.ts                 # IndexDb class wrapping better-sqlite3 (schema, FTS5, queries)
  indexer/index-repo.ts         # indexFiles + import graph resolution
  search/search.ts              # tokenize query -> FTS5 hits
  scorer/score.ts               # scoreCandidates + findDangerousFiles (core IP)
  report/schema.ts              # Zod ContextReport schema
  report/agent-rules.ts         # readAgentRules
  report/build.ts               # buildReport + renderMarkdown + writeReport
  exporters/claude.ts           # renderClaude
  core/run-init.ts              # runInit
  core/run-scan.ts              # runScan
  core/run-context.ts           # runContext
  core/run-export.ts            # runExport
  commands/init.ts              # oclif: sensei init
  commands/scan.ts              # oclif: sensei scan
  commands/context.ts           # oclif: sensei context "<task>"
  commands/export.ts            # oclif: sensei export --target claude
test/
  fixtures/sample-repo/         # tiny TS repo used by e2e + scanner/index tests
  tokenize.test.ts
  config.test.ts
  indexer-db.test.ts
  scanner.test.ts
  ast.test.ts
  index-repo.test.ts
  search.test.ts
  scorer.test.ts
  report.test.ts
  exporter.test.ts
  e2e.test.ts
```

### Locked interfaces (referenced across tasks)

```typescript
// src/types.ts
export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'enum';
export type Lang = 'ts' | 'tsx' | 'js' | 'jsx';

export interface ScannedFile {
  path: string;                 // repo-relative, posix-separated
  hash: string;                 // sha1 of file contents
  lang: Lang;
  loc: number;                  // line count
  gitLastModified: number | null; // unix seconds, null if not in git
  gitCommitCount: number;
}

export interface ExtractedSymbol {
  kind: SymbolKind;
  name: string;
  signature: string;
  exported: boolean;
  startLine: number;
  jsdoc: string;
}

export interface ExtractedImport {
  module: string;               // module specifier text
  importedName: string;         // named import, or 'default' / '*'
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

export interface ReuseCandidate {
  path: string;
  line: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  score: number;                // 0..1
  reasons: string[];
}

export interface DangerousFile {
  path: string;
  importerCount: number;
  reason: string;
}

export interface ContextReport {
  task: string;
  generatedAt: string;          // ISO string
  reuseCandidates: ReuseCandidate[];
  dangerousFiles: DangerousFile[];
  agentRules: string[];
}
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `bin/run.js`, `src/commands/.gitkeep`, `test/scaffold.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "sensei",
  "version": "0.1.0",
  "description": "Before your AI agent writes code, Sensei tells it what already exists, what to reuse, and what not to touch.",
  "type": "module",
  "bin": { "sensei": "./bin/run.js" },
  "files": ["dist", "bin"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@oclif/core": "^4.0.0",
    "better-sqlite3": "^11.0.0",
    "fast-glob": "^3.3.0",
    "ignore": "^6.0.0",
    "simple-git": "^3.25.0",
    "ts-morph": "^24.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "oclif": {
    "bin": "sensei",
    "dirname": "sensei",
    "commands": "./dist/commands",
    "topicSeparator": " "
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
.DS_Store
.sensei/cache.db
```

- [ ] **Step 5: Create `bin/run.js`**

```javascript
#!/usr/bin/env node
import { execute } from '@oclif/core';
await execute({ dir: import.meta.url });
```

- [ ] **Step 6: Create `src/commands/.gitkeep`** (empty file so the commands dir exists)

- [ ] **Step 7: Create scaffold smoke test `test/scaffold.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('runs the test runner', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`
Expected: completes, creates `pnpm-lock.yaml` and `node_modules/`.

- [ ] **Step 9: Run the test to verify the toolchain works**

Run: `pnpm test`
Expected: PASS (1 test passed).

- [ ] **Step 10: Verify the build compiles (no commands yet, that's fine)**

Run: `pnpm build`
Expected: exits 0, creates `dist/`.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold sensei package (oclif ESM + vitest + tsc)"
```

---

## Task 2: Shared types + tokenizer

**Files:**
- Create: `src/types.ts`, `src/text/tokenize.ts`, `src/paths.ts`
- Test: `test/tokenize.test.ts`

- [ ] **Step 1: Create `src/types.ts`** (paste the full "Locked interfaces" block from the File Structure section above into `src/types.ts`)

- [ ] **Step 2: Create `src/paths.ts`**

```typescript
import path from 'node:path';

export const SENSEI_DIR = '.sensei';
export const senseiDir = (cwd: string) => path.join(cwd, SENSEI_DIR);
export const configPath = (cwd: string) => path.join(senseiDir(cwd), 'sensei.config.json');
export const dbPath = (cwd: string) => path.join(senseiDir(cwd), 'cache.db');
export const contextMdPath = (cwd: string) => path.join(senseiDir(cwd), 'current-task-context.md');
export const candidatesJsonPath = (cwd: string) => path.join(senseiDir(cwd), 'reuse-candidates.json');
export const agentRulesPath = (cwd: string) => path.join(senseiDir(cwd), 'agent-rules.md');
```

- [ ] **Step 3: Write the failing test `test/tokenize.test.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test tokenize`
Expected: FAIL — cannot find module `../src/text/tokenize.js`.

- [ ] **Step 5: Implement `src/text/tokenize.ts`**

```typescript
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'is', 'be',
  'add', 'create', 'implement', 'support', 'feature', 'new', 'update', 'fix', 'make',
  'build', 'using', 'use', 'allow', 'enable', 'handle', 'into', 'from', 'this', 'that',
]);

export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .split(/[^a-zA-Z0-9]+/)                  // non-alphanumeric boundary
    .filter(Boolean);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of text.split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
    for (const part of splitIdentifier(word)) {
      const t = part.toLowerCase();
      if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tokenize`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/paths.ts src/text/tokenize.ts test/tokenize.test.ts
git commit -m "feat: add shared types, path helpers, and identifier-aware tokenizer"
```

---

## Task 3: Config module

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Implement `src/config/schema.ts`**

```typescript
import { z } from 'zod';

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  include: z.array(z.string()).default(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']),
  ignore: z.array(z.string()).default([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.sensei/**',
    '**/*.d.ts',
  ]),
  context: z
    .object({ topN: z.number().int().positive().default(10) })
    .default({}),
  scoring: z
    .object({
      nameOverlap: z.number().default(0.4),
      pathMatch: z.number().default(0.2),
      exportedBoost: z.number().default(0.15),
      gitRecency: z.number().default(0.15),
      testExists: z.number().default(0.1),
    })
    .default({}),
  dangerous: z
    .object({ importerThreshold: z.number().int().positive().default(5) })
    .default({}),
});

export type SenseiConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: SenseiConfig = ConfigSchema.parse({});
```

- [ ] **Step 2: Write the failing test `test/config.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from '../src/config/load.js';
import { configPath } from '../src/paths.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-cfg-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('config', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(dir);
    expect(cfg.version).toBe(1);
    expect(cfg.context.topN).toBe(10);
    expect(cfg.scoring.nameOverlap).toBe(0.4);
  });

  it('writes a default config file that round-trips', () => {
    writeDefaultConfig(dir);
    expect(fs.existsSync(configPath(dir))).toBe(true);
    const cfg = loadConfig(dir);
    expect(cfg.dangerous.importerThreshold).toBe(5);
  });

  it('merges partial user config over defaults', () => {
    fs.mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    fs.writeFileSync(configPath(dir), JSON.stringify({ context: { topN: 3 } }));
    const cfg = loadConfig(dir);
    expect(cfg.context.topN).toBe(3);
    expect(cfg.scoring.pathMatch).toBe(0.2); // untouched default
  });

  it('throws a clear error on malformed config', () => {
    fs.mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    fs.writeFileSync(configPath(dir), JSON.stringify({ context: { topN: -1 } }));
    expect(() => loadConfig(dir)).toThrow(/Invalid sensei.config.json/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test config`
Expected: FAIL — cannot find module `../src/config/load.js`.

- [ ] **Step 4: Implement `src/config/load.ts`**

```typescript
import fs from 'node:fs';
import { ConfigSchema, DEFAULT_CONFIG, type SenseiConfig } from './schema.js';
import { configPath, senseiDir } from '../paths.js';

export function loadConfig(cwd: string): SenseiConfig {
  const file = configPath(cwd);
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid sensei.config.json: not valid JSON (${(err as Error).message})`);
    }
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid sensei.config.json: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return result.data;
}

export function writeDefaultConfig(cwd: string): void {
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(configPath(cwd), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test config`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config test/config.test.ts
git commit -m "feat: add Zod-validated config schema with load/write"
```

---

## Task 4: Indexer DB — schema, open, meta, file rows

**Files:**
- Create: `src/indexer/db.ts`
- Test: `test/indexer-db.test.ts`

- [ ] **Step 1: Write the failing test `test/indexer-db.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { IndexDb } from '../src/indexer/db.js';
import type { ScannedFile } from '../src/types.js';

function file(over: Partial<ScannedFile> = {}): ScannedFile {
  return { path: 'src/a.ts', hash: 'h1', lang: 'ts', loc: 10, gitLastModified: 100, gitCommitCount: 2, ...over };
}

describe('IndexDb file rows', () => {
  it('creates schema and upserts a file, returning a stable id', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const id = db.upsertFile(file());
    expect(id).toBeGreaterThan(0);
    const again = db.upsertFile(file({ hash: 'h2', loc: 20 }));
    expect(again).toBe(id); // same path -> same row
    const row = db.getFileByPath('src/a.ts');
    expect(row?.hash).toBe('h2');
    expect(row?.loc).toBe(20);
    db.close();
  });

  it('lists all files and deletes files not in a kept set', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.upsertFile(file({ path: 'src/a.ts' }));
    db.upsertFile(file({ path: 'src/b.ts' }));
    db.deleteFilesNotIn(['src/a.ts']);
    expect(db.allFiles().map((f) => f.path)).toEqual(['src/a.ts']);
    db.close();
  });

  it('stores and reads meta', () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    db.setMeta('schema_version', '1');
    expect(db.getMeta('schema_version')).toBe('1');
    expect(db.getMeta('missing')).toBeUndefined();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test indexer-db`
Expected: FAIL — cannot find module `../src/indexer/db.js`.

- [ ] **Step 3: Implement `src/indexer/db.ts`**

```typescript
import Database from 'better-sqlite3';
import type { Database as BetterDb } from 'better-sqlite3';
import type { ScannedFile, ExtractedSymbol, ExtractedImport } from '../types.js';

export interface FileRow {
  id: number;
  path: string;
  hash: string;
  lang: string;
  loc: number;
  git_last_modified: number | null;
  git_commit_count: number;
  importer_count: number;
}

export interface SymbolHitRow {
  symbol_id: number;
  file_id: number;
  path: string;
  kind: string;
  name: string;
  signature: string;
  exported: number;
  start_line: number;
  jsdoc: string;
  git_last_modified: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  lang TEXT NOT NULL,
  loc INTEGER NOT NULL,
  git_last_modified INTEGER,
  git_commit_count INTEGER NOT NULL DEFAULT 0,
  importer_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER NOT NULL,
  jsdoc TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  imported_name TEXT NOT NULL,
  resolved_file_id INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, signature, jsdoc, path);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_file_id);
`;

export class IndexDb {
  readonly raw: BetterDb;

  constructor(path: string) {
    this.raw = new Database(path);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
  }

  migrate(): void {
    this.raw.exec(SCHEMA);
  }

  upsertFile(f: ScannedFile): number {
    this.raw
      .prepare(
        `INSERT INTO files (path, hash, lang, loc, git_last_modified, git_commit_count)
         VALUES (@path, @hash, @lang, @loc, @gitLastModified, @gitCommitCount)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash, lang = excluded.lang, loc = excluded.loc,
           git_last_modified = excluded.git_last_modified,
           git_commit_count = excluded.git_commit_count`,
      )
      .run(f);
    const row = this.raw.prepare('SELECT id FROM files WHERE path = ?').get(f.path) as { id: number };
    return row.id;
  }

  getFileByPath(path: string): FileRow | undefined {
    return this.raw.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
  }

  allFiles(): FileRow[] {
    return this.raw.prepare('SELECT * FROM files ORDER BY path').all() as FileRow[];
  }

  deleteFilesNotIn(keepPaths: string[]): void {
    const all = this.allFiles();
    const keep = new Set(keepPaths);
    const del = this.raw.prepare('DELETE FROM files WHERE id = ?');
    const tx = this.raw.transaction((rows: FileRow[]) => {
      for (const r of rows) if (!keep.has(r.path)) del.run(r.id);
    });
    tx(all);
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.raw.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  close(): void {
    this.raw.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test indexer-db`
Expected: PASS (3 tests).

> Note: deleting a file cascades to its symbols/imports via `ON DELETE CASCADE`. FTS rows are managed explicitly in Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/db.ts test/indexer-db.test.ts
git commit -m "feat: add SQLite IndexDb with schema, file upsert, and meta"
```

---

## Task 5: Repo scanner

**Files:**
- Create: `src/scanner/scan.ts`, `test/fixtures/sample-repo/` (fixture files below)
- Test: `test/scanner.test.ts`

- [ ] **Step 1: Create the fixture repo files**

Create `test/fixtures/sample-repo/src/auth/login.ts`:

```typescript
/** Authenticate a user with email + password. */
export function login(email: string, password: string): boolean {
  return email.length > 0 && password.length > 0;
}

export function hashPassword(password: string): string {
  return password.split('').reverse().join('');
}
```

Create `test/fixtures/sample-repo/src/auth/index.ts`:

```typescript
export { login, hashPassword } from './login.js';
```

Create `test/fixtures/sample-repo/src/user/profile.ts`:

```typescript
import { login } from '../auth/login.js';

export class UserProfile {
  constructor(public email: string) {}
  canLogin(password: string): boolean {
    return login(this.email, password);
  }
}
```

Create `test/fixtures/sample-repo/src/index.ts`:

```typescript
import { login } from './auth/login.js';
import { UserProfile } from './user/profile.js';

export function main(): void {
  const ok = login('a@b.com', 'pw');
  void new UserProfile('a@b.com');
  void ok;
}
```

Create `test/fixtures/sample-repo/src/auth/login.test.ts`:

```typescript
import { login } from './login.js';
import { describe, it, expect } from 'vitest';
describe('login', () => { it('works', () => { expect(login('a', 'b')).toBe(true); }); });
```

Create `test/fixtures/sample-repo/.gitignore`:

```
ignored-dir/
```

Create `test/fixtures/sample-repo/ignored-dir/skip.ts`:

```typescript
export const SKIP = true;
```

- [ ] **Step 2: Write the failing test `test/scanner.test.ts`**

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test scanner`
Expected: FAIL — cannot find module `../src/scanner/scan.js`.

- [ ] **Step 4: Implement `src/scanner/scan.ts`**

```typescript
import fg from 'fast-glob';
import ignore from 'ignore';
import { simpleGit } from 'simple-git';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ScannedFile, Lang } from '../types.js';
import type { SenseiConfig } from '../config/schema.js';

function extLang(rel: string): Lang {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.ts')) return 'ts';
  if (rel.endsWith('.jsx')) return 'jsx';
  return 'js';
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

export async function scanRepo(cwd: string, config: SenseiConfig): Promise<ScannedFile[]> {
  const entries = await fg(config.include, {
    cwd,
    ignore: config.ignore,
    onlyFiles: true,
    dot: false,
  });

  const ig = ignore();
  const giPath = path.join(cwd, '.gitignore');
  if (fs.existsSync(giPath)) ig.add(fs.readFileSync(giPath, 'utf8'));
  const kept = entries.filter((p) => !ig.ignores(p)).sort();

  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);

  const files: ScannedFile[] = [];
  for (const rel of kept) {
    const abs = path.join(cwd, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable file: skip
    }
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    const loc = content.length === 0 ? 0 : content.split('\n').length;

    let gitLastModified: number | null = null;
    let gitCommitCount = 0;
    if (isRepo) {
      try {
        const log = await git.log({ file: rel });
        gitCommitCount = log.total;
        if (log.latest) gitLastModified = Math.floor(new Date(log.latest.date).getTime() / 1000);
      } catch {
        // file not tracked yet: leave git fields at defaults
      }
    }

    files.push({ path: toPosix(rel), hash, lang: extLang(rel), loc, gitLastModified, gitCommitCount });
  }
  return files;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test scanner`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/scanner/scan.ts test/fixtures test/scanner.test.ts
git commit -m "feat: add repo scanner (fast-glob + ignore + git metadata) and fixture repo"
```

---

## Task 6: AST extraction

**Files:**
- Create: `src/ast/extract.ts`
- Test: `test/ast.test.ts`

- [ ] **Step 1: Write the failing test `test/ast.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/ast/extract.js';

const SRC = `
import { login } from '../auth/login.js';
import Default from 'pkg';

/** Authenticate. */
export function authenticate(user: string, pass: string): boolean {
  return login(user, pass);
}

export class Session {
  start(): void {}
}

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test ast`
Expected: FAIL — cannot find module `../src/ast/extract.js`.

- [ ] **Step 3: Implement `src/ast/extract.ts`**

```typescript
import { Project, SyntaxKind } from 'ts-morph';
import type {
  FileExtraction,
  ExtractedSymbol,
  ExtractedImport,
} from '../types.js';

function jsdocOf(node: { getJsDocs?: () => Array<{ getCommentText(): string | undefined }> }): string {
  const docs = node.getJsDocs?.() ?? [];
  return docs.map((d) => d.getCommentText() ?? '').join(' ').trim();
}

export function extractFromSource(filePath: string, source: string): FileExtraction {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });
  const sf = project.createSourceFile(filePath, source, { overwrite: true });

  const symbols: ExtractedSymbol[] = [];
  const push = (s: ExtractedSymbol) => symbols.push(s);

  // Functions
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const params = fn.getParameters().map((p) => p.getText()).join(', ');
    const ret = fn.getReturnTypeNode()?.getText();
    push({
      kind: 'function',
      name,
      signature: `${name}(${params})${ret ? ': ' + ret : ''}`,
      exported: fn.isExported(),
      startLine: fn.getStartLineNumber(),
      jsdoc: jsdocOf(fn as never),
    });
  }

  // Classes + methods
  for (const cls of sf.getClasses()) {
    const name = cls.getName();
    if (!name) continue;
    push({
      kind: 'class',
      name,
      signature: `class ${name}`,
      exported: cls.isExported(),
      startLine: cls.getStartLineNumber(),
      jsdoc: jsdocOf(cls as never),
    });
    for (const m of cls.getMethods()) {
      const params = m.getParameters().map((p) => p.getText()).join(', ');
      const ret = m.getReturnTypeNode()?.getText();
      push({
        kind: 'method',
        name: `${name}.${m.getName()}`,
        signature: `${m.getName()}(${params})${ret ? ': ' + ret : ''}`,
        exported: cls.isExported(),
        startLine: m.getStartLineNumber(),
        jsdoc: jsdocOf(m as never),
      });
    }
  }

  // Interfaces / type aliases / enums
  for (const i of sf.getInterfaces()) {
    push({ kind: 'interface', name: i.getName(), signature: `interface ${i.getName()}`, exported: i.isExported(), startLine: i.getStartLineNumber(), jsdoc: jsdocOf(i as never) });
  }
  for (const t of sf.getTypeAliases()) {
    push({ kind: 'type', name: t.getName(), signature: `type ${t.getName()}`, exported: t.isExported(), startLine: t.getStartLineNumber(), jsdoc: jsdocOf(t as never) });
  }
  for (const e of sf.getEnums()) {
    push({ kind: 'enum', name: e.getName(), signature: `enum ${e.getName()}`, exported: e.isExported(), startLine: e.getStartLineNumber(), jsdoc: jsdocOf(e as never) });
  }

  // Top-level variable declarations only
  for (const vd of sf.getVariableDeclarations()) {
    const stmt = vd.getVariableStatement();
    if (!stmt || stmt.getParentOrThrow().getKind() !== SyntaxKind.SourceFile) continue;
    push({
      kind: 'const',
      name: vd.getName(),
      signature: vd.getName(),
      exported: stmt.isExported(),
      startLine: vd.getStartLineNumber(),
      jsdoc: jsdocOf(stmt as never),
    });
  }

  // Imports
  const imports: ExtractedImport[] = [];
  for (const imp of sf.getImportDeclarations()) {
    const module = imp.getModuleSpecifierValue();
    if (imp.getDefaultImport()) imports.push({ module, importedName: 'default' });
    if (imp.getNamespaceImport()) imports.push({ module, importedName: '*' });
    for (const n of imp.getNamedImports()) imports.push({ module, importedName: n.getName() });
    if (!imp.getDefaultImport() && !imp.getNamespaceImport() && imp.getNamedImports().length === 0) {
      imports.push({ module, importedName: '' }); // side-effect import
    }
  }

  return { symbols, imports };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test ast`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ast/extract.ts test/ast.test.ts
git commit -m "feat: add ts-morph AST extraction for symbols and imports"
```

---

## Task 7: Index writing — symbols, imports, FTS, import graph

**Files:**
- Modify: `src/indexer/db.ts` (add symbol/import/FTS/search/graph methods)
- Create: `src/indexer/index-repo.ts`
- Test: `test/index-repo.test.ts`

- [ ] **Step 1: Add methods to `IndexDb` in `src/indexer/db.ts`** (insert these methods inside the `IndexDb` class, before `close()`)

```typescript
  clearFileEntities(fileId: number): void {
    const ids = this.raw.prepare('SELECT id FROM symbols WHERE file_id = ?').all(fileId) as Array<{ id: number }>;
    const delFts = this.raw.prepare('DELETE FROM symbols_fts WHERE rowid = ?');
    for (const { id } of ids) delFts.run(id);
    this.raw.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    this.raw.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
  }

  insertSymbol(fileId: number, s: ExtractedSymbol, path: string): void {
    const info = this.raw
      .prepare(
        `INSERT INTO symbols (file_id, kind, name, signature, exported, start_line, jsdoc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fileId, s.kind, s.name, s.signature, s.exported ? 1 : 0, s.startLine, s.jsdoc);
    this.raw
      .prepare('INSERT INTO symbols_fts (rowid, name, signature, jsdoc, path) VALUES (?, ?, ?, ?, ?)')
      .run(info.lastInsertRowid, s.name, s.signature, s.jsdoc, path);
  }

  insertImport(fileId: number, imp: ExtractedImport): void {
    this.raw
      .prepare('INSERT INTO imports (file_id, module, imported_name) VALUES (?, ?, ?)')
      .run(fileId, imp.module, imp.importedName);
  }

  allImports(): Array<{ id: number; file_id: number; file_path: string; module: string }> {
    return this.raw
      .prepare('SELECT i.id, i.file_id, f.path AS file_path, i.module FROM imports i JOIN files f ON f.id = i.file_id')
      .all() as Array<{ id: number; file_id: number; file_path: string; module: string }>;
  }

  setImportResolution(importId: number, resolvedFileId: number | null): void {
    this.raw.prepare('UPDATE imports SET resolved_file_id = ? WHERE id = ?').run(resolvedFileId, importId);
  }

  recomputeImporterCounts(): void {
    this.raw.exec(
      `UPDATE files SET importer_count = (
         SELECT COUNT(DISTINCT i.file_id) FROM imports i WHERE i.resolved_file_id = files.id
       )`,
    );
  }

  fileIdByPath(): Map<string, number> {
    const rows = this.raw.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>;
    return new Map(rows.map((r) => [r.path, r.id]));
  }

  searchSymbols(matchExpr: string, limit: number): SymbolHitRow[] {
    return this.raw
      .prepare(
        `SELECT s.id AS symbol_id, s.file_id, f.path, s.kind, s.name, s.signature,
                s.exported, s.start_line, s.jsdoc, f.git_last_modified
         FROM symbols_fts fts
         JOIN symbols s ON s.id = fts.rowid
         JOIN files f ON f.id = s.file_id
         WHERE symbols_fts MATCH ?
         ORDER BY s.id
         LIMIT ?`,
      )
      .all(matchExpr, limit) as SymbolHitRow[];
  }

  mtimeStats(): { min: number | null; max: number | null } {
    const row = this.raw
      .prepare('SELECT MIN(git_last_modified) AS min, MAX(git_last_modified) AS max FROM files WHERE git_last_modified IS NOT NULL')
      .get() as { min: number | null; max: number | null };
    return row;
  }

  countSymbols(): number {
    return (this.raw.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;
  }
```

- [ ] **Step 2: Write the failing test `test/index-repo.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/indexer/db.js';
import { scanRepo } from '../src/scanner/scan.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('indexFiles', () => {
  it('indexes symbols, resolves the import graph, and computes importer_count', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const files = await scanRepo(repo, DEFAULT_CONFIG);
    const result = indexFiles(db, repo, files);

    expect(result.fileCount).toBe(files.length);
    expect(result.symbolCount).toBeGreaterThan(0);

    // login.ts is imported by index.ts, profile.ts, and re-exported by auth/index.ts
    const login = db.getFileByPath('src/auth/login.ts')!;
    expect(login.importer_count).toBeGreaterThanOrEqual(2);

    // FTS search finds the login function
    const hits = db.searchSymbols('"login"', 50);
    expect(hits.some((h) => h.name === 'login')).toBe(true);
  });

  it('is incremental: a second run with unchanged files re-parses nothing', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    const files = await scanRepo(repo, DEFAULT_CONFIG);
    indexFiles(db, repo, files);
    const second = indexFiles(db, repo, files);
    expect(second.changed).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test index-repo`
Expected: FAIL — cannot find module `../src/indexer/index-repo.js`.

- [ ] **Step 4: Implement `src/indexer/index-repo.ts`**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { IndexDb } from './db.js';
import { extractFromSource } from '../ast/extract.js';
import type { ScannedFile } from '../types.js';

export interface IndexResult {
  fileCount: number;
  symbolCount: number;
  changed: number;
  warnings: string[];
}

const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

/** Resolve a relative module specifier from an importer path to a known repo file path. */
function resolveModule(importerPath: string, moduleSpec: string, known: Set<string>): string | null {
  if (!moduleSpec.startsWith('.')) return null; // external package
  const joined = path.posix.join(path.posix.dirname(importerPath), moduleSpec);
  const stripped = joined.replace(/\.(ts|tsx|js|jsx)$/, ''); // map ./x.js specifier -> ./x source
  const candidates = [
    joined,                                          // exact (e.g. importing ./x.ts directly)
    ...EXTS.map((e) => stripped + e),                // ./x -> ./x.ts
    ...EXTS.map((e) => stripped + '/index' + e),     // ./dir -> ./dir/index.ts
  ];
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

export function indexFiles(db: IndexDb, cwd: string, files: ScannedFile[]): IndexResult {
  const warnings: string[] = [];
  let changed = 0;

  const tx = db.raw.transaction(() => {
    db.deleteFilesNotIn(files.map((f) => f.path));

    for (const f of files) {
      const existing = db.getFileByPath(f.path);
      const fileId = db.upsertFile(f);
      if (existing && existing.hash === f.hash) continue; // unchanged: skip re-parse
      changed++;

      let source: string;
      try {
        source = fs.readFileSync(path.join(cwd, f.path), 'utf8');
      } catch {
        warnings.push(`could not read ${f.path}`);
        continue;
      }

      db.clearFileEntities(fileId);
      let extraction;
      try {
        extraction = extractFromSource(f.path, source);
      } catch (err) {
        warnings.push(`could not parse ${f.path}: ${(err as Error).message}`);
        continue;
      }
      for (const s of extraction.symbols) db.insertSymbol(fileId, s, f.path);
      for (const imp of extraction.imports) db.insertImport(fileId, imp);
    }

    // Resolve the import graph
    const known = new Set(db.fileIdByPath().keys());
    const idByPath = db.fileIdByPath();
    for (const imp of db.allImports()) {
      const resolved = resolveModule(imp.file_path, imp.module, known);
      db.setImportResolution(imp.id, resolved ? idByPath.get(resolved) ?? null : null);
    }
    db.recomputeImporterCounts();
  });
  tx();

  return { fileCount: files.length, symbolCount: db.countSymbols(), changed, warnings };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test index-repo`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/indexer/db.ts src/indexer/index-repo.ts test/index-repo.test.ts
git commit -m "feat: index symbols/imports into SQLite with FTS5 and import-graph fan-in"
```

---

## Task 8: Search

**Files:**
- Create: `src/search/search.ts`
- Test: `test/search.test.ts`

- [ ] **Step 1: Write the failing test `test/search.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { buildMatchExpr, searchSymbols } from '../src/search/search.js';
import { IndexDb } from '../src/indexer/db.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { scanRepo } from '../src/scanner/scan.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('search', () => {
  it('builds a quoted OR FTS expression', () => {
    expect(buildMatchExpr(['login', 'password'])).toBe('"login" OR "password"');
  });

  it('returns [] for no tokens', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    expect(searchSymbols(db, [])).toEqual([]);
  });

  it('finds symbols matching task tokens', async () => {
    const db = new IndexDb(':memory:');
    db.migrate();
    indexFiles(db, repo, await scanRepo(repo, DEFAULT_CONFIG));
    const hits = searchSymbols(db, ['login', 'password']);
    expect(hits.some((h) => h.name === 'login')).toBe(true);
    expect(hits.some((h) => h.name === 'hashPassword')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test search`
Expected: FAIL — cannot find module `../src/search/search.js`.

- [ ] **Step 3: Implement `src/search/search.ts`**

```typescript
import type { IndexDb, SymbolHitRow } from '../indexer/db.js';

/** Build a safe FTS5 MATCH expression: OR of quoted tokens. */
export function buildMatchExpr(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export function searchSymbols(db: IndexDb, tokens: string[], limit = 200): SymbolHitRow[] {
  if (tokens.length === 0) return [];
  return db.searchSymbols(buildMatchExpr(tokens), limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test search`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/search/search.ts test/search.test.ts
git commit -m "feat: add FTS5-backed symbol search"
```

---

## Task 9: Scorer (core IP)

**Files:**
- Create: `src/scorer/score.ts`
- Test: `test/scorer.test.ts`

- [ ] **Step 1: Write the failing test `test/scorer.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { scoreCandidates, findDangerousFiles } from '../src/scorer/score.js';
import { IndexDb } from '../src/indexer/db.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { scanRepo } from '../src/scanner/scan.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { searchSymbols } from '../src/search/search.js';
import { tokenize } from '../src/text/tokenize.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

async function buildIndex() {
  const db = new IndexDb(':memory:');
  db.migrate();
  indexFiles(db, repo, await scanRepo(repo, DEFAULT_CONFIG));
  return db;
}

describe('scoreCandidates', () => {
  it('ranks the most relevant exported symbol first and is deterministic', async () => {
    const db = await buildIndex();
    const tokens = tokenize('add login with password');
    const hits = searchSymbols(db, tokens);
    const ranked = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[ranked.length - 1].score);
    expect(ranked[0].name).toBe('login');
    expect(ranked[0].reasons.length).toBeGreaterThan(0);
    // determinism: same inputs -> identical ranking
    const again = scoreCandidates(hits, tokens, DEFAULT_CONFIG, db);
    expect(again.map((r) => `${r.name}:${r.score}`)).toEqual(ranked.map((r) => `${r.name}:${r.score}`));
  });

  it('scores are clamped to [0,1]', async () => {
    const db = await buildIndex();
    const tokens = tokenize('login password');
    const ranked = scoreCandidates(searchSymbols(db, tokens), tokens, DEFAULT_CONFIG, db);
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe('findDangerousFiles', () => {
  it('flags high-fan-in files and entrypoints', async () => {
    const db = await buildIndex();
    const cfg = { ...DEFAULT_CONFIG, dangerous: { importerThreshold: 2 } };
    const danger = findDangerousFiles(db, cfg);
    expect(danger.some((d) => d.path === 'src/auth/login.ts')).toBe(true);
    expect(danger.some((d) => d.path === 'src/index.ts')).toBe(true); // entrypoint
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test scorer`
Expected: FAIL — cannot find module `../src/scorer/score.js`.

- [ ] **Step 3: Implement `src/scorer/score.ts`**

```typescript
import type { IndexDb, SymbolHitRow, FileRow } from '../indexer/db.js';
import type { ReuseCandidate, DangerousFile, SymbolKind } from '../types.js';
import type { SenseiConfig } from '../config/schema.js';
import { tokenize } from '../text/tokenize.js';

/** Stems (basename without extension/test-suffix) that have an associated test file. */
function testedStems(files: FileRow[]): Set<string> {
  const stems = new Set<string>();
  for (const f of files) {
    const m = f.path.match(/([^/]+)\.(test|spec)\.(ts|tsx|js|jsx)$/);
    if (m) stems.add(m[1]);
  }
  return stems;
}

function baseStem(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.(ts|tsx|js|jsx)$/, '');
}

export function scoreCandidates(
  hits: SymbolHitRow[],
  queryTokens: string[],
  config: SenseiConfig,
  db: IndexDb,
): ReuseCandidate[] {
  const w = config.scoring;
  const { min, max } = db.mtimeStats();
  const tested = testedStems(db.allFiles());

  const candidates: ReuseCandidate[] = hits.map((hit) => {
    const reasons: string[] = [];
    let score = 0;

    const nameTokens = tokenize(`${hit.name} ${hit.signature}`);
    const overlap = queryTokens.filter((t) => nameTokens.includes(t)).length;
    if (overlap > 0 && queryTokens.length > 0) {
      const nameScore = overlap / queryTokens.length;
      score += w.nameOverlap * nameScore;
      reasons.push(`name/signature matches ${overlap} task term(s)`);
    }

    const pathTokens = tokenize(hit.path);
    if (queryTokens.some((t) => pathTokens.includes(t))) {
      score += w.pathMatch;
      reasons.push('file path matches task domain');
    }

    if (hit.exported === 1) {
      score += w.exportedBoost;
      reasons.push('exported (public API)');
    }

    if (hit.git_last_modified != null && min != null && max != null && max > min) {
      const recency = (hit.git_last_modified - min) / (max - min);
      if (recency > 0) {
        score += w.gitRecency * recency;
        reasons.push('recently modified');
      }
    }

    if (tested.has(baseStem(hit.path))) {
      score += w.testExists;
      reasons.push('has tests nearby');
    }

    return {
      path: hit.path,
      line: hit.start_line,
      name: hit.name,
      kind: hit.kind as SymbolKind,
      signature: hit.signature,
      score: Math.max(0, Math.min(1, score)),
      reasons,
    };
  });

  // Deterministic ordering: score desc, then path asc, then name asc
  candidates.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  );
  return candidates;
}

function isEntrypoint(p: string): boolean {
  return /(^|\/)(index|main)\.(ts|tsx|js|jsx)$/.test(p);
}

export function findDangerousFiles(db: IndexDb, config: SenseiConfig): DangerousFile[] {
  const out: DangerousFile[] = [];
  for (const f of db.allFiles()) {
    if (f.importer_count >= config.dangerous.importerThreshold) {
      out.push({ path: f.path, importerCount: f.importer_count, reason: `${f.importer_count} files import this` });
    } else if (isEntrypoint(f.path)) {
      out.push({ path: f.path, importerCount: f.importer_count, reason: 'entrypoint file' });
    }
  }
  out.sort((a, b) => b.importerCount - a.importerCount || a.path.localeCompare(b.path));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test scorer`
Expected: PASS (3 tests).

> Note: `FileRow` is imported as a type from `db.js`; it is already exported there (Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/scorer/score.ts test/scorer.test.ts
git commit -m "feat: add deterministic reuse scorer and dangerous-file detection"
```

---

## Task 10: Report (schema, agent rules, build, markdown)

**Files:**
- Create: `src/report/schema.ts`, `src/report/agent-rules.ts`, `src/report/build.ts`
- Test: `test/report.test.ts`

- [ ] **Step 1: Implement `src/report/schema.ts`**

```typescript
import { z } from 'zod';

export const ReuseCandidateSchema = z.object({
  path: z.string(),
  line: z.number(),
  name: z.string(),
  kind: z.string(),
  signature: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
});

export const DangerousFileSchema = z.object({
  path: z.string(),
  importerCount: z.number(),
  reason: z.string(),
});

export const ContextReportSchema = z.object({
  task: z.string(),
  generatedAt: z.string(),
  reuseCandidates: z.array(ReuseCandidateSchema),
  dangerousFiles: z.array(DangerousFileSchema),
  agentRules: z.array(z.string()),
});
```

- [ ] **Step 2: Implement `src/report/agent-rules.ts`**

```typescript
import fs from 'node:fs';
import { agentRulesPath } from '../paths.js';

export function readAgentRules(cwd: string): string[] {
  const file = agentRulesPath(cwd);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim())
    .filter((l): l is string => Boolean(l));
}
```

- [ ] **Step 3: Write the failing test `test/report.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { buildReport, renderMarkdown } from '../src/report/build.js';
import { ContextReportSchema } from '../src/report/schema.js';
import type { ReuseCandidate, DangerousFile } from '../src/types.js';

const candidates: ReuseCandidate[] = [
  { path: 'src/auth/login.ts', line: 2, name: 'login', kind: 'function', signature: 'login(email: string, password: string): boolean', score: 0.85, reasons: ['exported (public API)'] },
];
const dangerous: DangerousFile[] = [
  { path: 'src/auth/login.ts', importerCount: 3, reason: '3 files import this' },
];

describe('report', () => {
  it('builds a schema-valid report with a fixed timestamp', () => {
    const report = buildReport('add password reset', candidates, dangerous, ['Reuse existing code'], new Date('2026-06-16T00:00:00Z'));
    expect(() => ContextReportSchema.parse(report)).not.toThrow();
    expect(report.task).toBe('add password reset');
    expect(report.generatedAt).toBe('2026-06-16T00:00:00.000Z');
  });

  it('renders markdown with reuse candidates and dangerous files', () => {
    const report = buildReport('add password reset', candidates, dangerous, ['Reuse existing code'], new Date('2026-06-16T00:00:00Z'));
    const md = renderMarkdown(report);
    expect(md).toContain('# Sensei Context');
    expect(md).toContain('src/auth/login.ts:2');
    expect(md).toContain('login(email: string, password: string)');
    expect(md).toContain('Do not casually edit');
    expect(md).toContain('Reuse existing code');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test report`
Expected: FAIL — cannot find module `../src/report/build.js`.

- [ ] **Step 5: Implement `src/report/build.ts`**

```typescript
import fs from 'node:fs';
import type { ContextReport, ReuseCandidate, DangerousFile } from '../types.js';
import { ContextReportSchema } from './schema.js';
import { senseiDir, contextMdPath, candidatesJsonPath } from '../paths.js';

export function buildReport(
  task: string,
  reuseCandidates: ReuseCandidate[],
  dangerousFiles: DangerousFile[],
  agentRules: string[],
  now: Date = new Date(),
): ContextReport {
  return { task, generatedAt: now.toISOString(), reuseCandidates, dangerousFiles, agentRules };
}

export function renderMarkdown(report: ContextReport): string {
  const lines: string[] = [];
  lines.push('# Sensei Context');
  lines.push('');
  lines.push(`**Task:** ${report.task}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push('');

  lines.push('## Reuse first — existing code that may already do this');
  lines.push('');
  if (report.reuseCandidates.length === 0) {
    lines.push('_No strong matches found._');
  } else {
    for (const c of report.reuseCandidates) {
      lines.push(`- \`${c.path}:${c.line}\` — **${c.name}** \`${c.signature}\` (score ${c.score.toFixed(2)})`);
      if (c.reasons.length) lines.push(`  - ${c.reasons.join('; ')}`);
    }
  }
  lines.push('');

  lines.push('## Do not casually edit — high-impact / entrypoint files');
  lines.push('');
  if (report.dangerousFiles.length === 0) {
    lines.push('_None detected._');
  } else {
    for (const d of report.dangerousFiles) lines.push(`- \`${d.path}\` — ${d.reason}`);
  }
  lines.push('');

  lines.push('## Agent rules');
  lines.push('');
  if (report.agentRules.length === 0) {
    lines.push('_No rules defined._');
  } else {
    for (const r of report.agentRules) lines.push(`- ${r}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeReport(cwd: string, report: ContextReport): void {
  const safe = ContextReportSchema.parse(report);
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(contextMdPath(cwd), renderMarkdown(safe));
  fs.writeFileSync(candidatesJsonPath(cwd), JSON.stringify(safe, null, 2) + '\n');
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test report`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/report test/report.test.ts
git commit -m "feat: add context report builder, markdown renderer, and writer"
```

---

## Task 11: Claude exporter

**Files:**
- Create: `src/exporters/claude.ts`
- Test: `test/exporter.test.ts`

- [ ] **Step 1: Write the failing test `test/exporter.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { renderClaude } from '../src/exporters/claude.js';
import type { ContextReport } from '../src/types.js';

const report: ContextReport = {
  task: 'add password reset',
  generatedAt: '2026-06-16T00:00:00.000Z',
  reuseCandidates: [
    { path: 'src/auth/login.ts', line: 2, name: 'login', kind: 'function', signature: 'login(email, password): boolean', score: 0.85, reasons: ['exported'] },
  ],
  dangerousFiles: [{ path: 'src/auth/login.ts', importerCount: 3, reason: '3 files import this' }],
  agentRules: ['Reuse existing code'],
};

describe('renderClaude', () => {
  it('renders a Claude-ready block leading with reuse and do-not-touch', () => {
    const out = renderClaude(report);
    expect(out).toContain('SENSEI CONTEXT');
    expect(out).toContain('add password reset');
    expect(out).toContain('REUSE THESE');
    expect(out).toContain('src/auth/login.ts:2');
    expect(out).toContain('DO NOT TOUCH');
    expect(out.indexOf('REUSE THESE')).toBeLessThan(out.indexOf('DO NOT TOUCH'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test exporter`
Expected: FAIL — cannot find module `../src/exporters/claude.js`.

- [ ] **Step 3: Implement `src/exporters/claude.ts`**

```typescript
import type { ContextReport } from '../types.js';

export function renderClaude(report: ContextReport): string {
  const lines: string[] = [];
  lines.push('=== SENSEI CONTEXT (read before writing code) ===');
  lines.push(`Task: ${report.task}`);
  lines.push('');
  lines.push('## REUSE THESE (do not reimplement):');
  if (report.reuseCandidates.length === 0) {
    lines.push('- (no strong matches found)');
  } else {
    for (const c of report.reuseCandidates) {
      lines.push(`- ${c.path}:${c.line} ${c.name} — ${c.signature}`);
    }
  }
  lines.push('');
  lines.push('## DO NOT TOUCH without confirmation (high-impact files):');
  if (report.dangerousFiles.length === 0) {
    lines.push('- (none detected)');
  } else {
    for (const d of report.dangerousFiles) lines.push(`- ${d.path} (${d.reason})`);
  }
  lines.push('');
  lines.push('## RULES:');
  for (const r of report.agentRules) lines.push(`- ${r}`);
  lines.push('=== END SENSEI CONTEXT ===');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test exporter`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/exporters/claude.ts test/exporter.test.ts
git commit -m "feat: add Claude-target exporter"
```

---

## Task 12: Core orchestration layer

**Files:**
- Create: `src/core/run-init.ts`, `src/core/run-scan.ts`, `src/core/run-context.ts`, `src/core/run-export.ts`
- (Tested via the e2e test in Task 14.)

- [ ] **Step 1: Implement `src/core/run-init.ts`**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { senseiDir, agentRulesPath, configPath } from '../paths.js';
import { writeDefaultConfig } from '../config/load.js';

const DEFAULT_AGENT_RULES = `# Agent Rules

- Reuse existing functions and modules listed in the context report before writing new ones.
- Do not modify files in the "do not touch" list without explicit confirmation.
- Match the existing code style, naming, and patterns of nearby files.
- Add or update tests for any behavior you change.
`;

export interface InitResult {
  created: string[];
}

export function runInit(cwd: string): InitResult {
  const created: string[] = [];
  fs.mkdirSync(senseiDir(cwd), { recursive: true });

  if (!fs.existsSync(configPath(cwd))) {
    writeDefaultConfig(cwd);
    created.push('.sensei/sensei.config.json');
  }
  if (!fs.existsSync(agentRulesPath(cwd))) {
    fs.writeFileSync(agentRulesPath(cwd), DEFAULT_AGENT_RULES);
    created.push('.sensei/agent-rules.md');
  }

  // Ensure the cache db is gitignored
  const gitignore = path.join(cwd, '.gitignore');
  const entry = '.sensei/cache.db';
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === entry)) {
    fs.writeFileSync(gitignore, (current && !current.endsWith('\n') ? current + '\n' : current) + entry + '\n');
    created.push('.gitignore (+.sensei/cache.db)');
  }
  return created.length ? { created } : { created: [] };
}
```

- [ ] **Step 2: Implement `src/core/run-scan.ts`**

```typescript
import { loadConfig } from '../config/load.js';
import { scanRepo } from '../scanner/scan.js';
import { IndexDb } from '../indexer/db.js';
import { indexFiles, type IndexResult } from '../indexer/index-repo.js';
import { dbPath, senseiDir } from '../paths.js';
import fs from 'node:fs';

export async function runScan(cwd: string): Promise<IndexResult> {
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  const config = loadConfig(cwd);
  const files = await scanRepo(cwd, config);
  const db = new IndexDb(dbPath(cwd));
  try {
    db.migrate();
    const result = indexFiles(db, cwd, files);
    db.setMeta('schema_version', '1');
    db.setMeta('last_scan', new Date().toISOString());
    return result;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 3: Implement `src/core/run-context.ts`**

```typescript
import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import { dbPath } from '../paths.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { scoreCandidates, findDangerousFiles } from '../scorer/score.js';
import { readAgentRules } from '../report/agent-rules.js';
import { buildReport, writeReport } from '../report/build.js';
import type { ContextReport } from '../types.js';

export async function runContext(cwd: string, task: string, now: Date = new Date()): Promise<ContextReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const db = new IndexDb(dbPath(cwd));
  try {
    const tokens = tokenize(task);
    const hits = searchSymbols(db, tokens);
    const ranked = scoreCandidates(hits, tokens, config, db).slice(0, config.context.topN);
    const dangerous = findDangerousFiles(db, config);
    const rules = readAgentRules(cwd);
    const report = buildReport(task, ranked, dangerous, rules, now);
    writeReport(cwd, report);
    return report;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Implement `src/core/run-export.ts`**

```typescript
import fs from 'node:fs';
import { candidatesJsonPath } from '../paths.js';
import { ContextReportSchema } from '../report/schema.js';
import { renderClaude } from '../exporters/claude.js';
import type { ContextReport } from '../types.js';

const TARGETS = ['claude', 'cursor', 'codex'] as const;
export type ExportTarget = (typeof TARGETS)[number];

export function runExport(cwd: string, target: string): string {
  if (!fs.existsSync(candidatesJsonPath(cwd))) {
    throw new Error('No context report found. Run `sensei context "<task>"` first.');
  }
  const report: ContextReport = ContextReportSchema.parse(
    JSON.parse(fs.readFileSync(candidatesJsonPath(cwd), 'utf8')),
  );
  if (target === 'claude') return renderClaude(report);
  if (target === 'cursor' || target === 'codex') {
    throw new Error(`Export target "${target}" is not implemented yet (Phase 2). Use --target claude.`);
  }
  throw new Error(`Unknown export target "${target}". Supported: ${TARGETS.join(', ')}.`);
}
```

- [ ] **Step 5: Typecheck (no dedicated unit test; e2e covers behavior)**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/core
git commit -m "feat: add core orchestration (init/scan/context/export)"
```

---

## Task 13: oclif commands

**Files:**
- Create: `src/commands/init.ts`, `src/commands/scan.ts`, `src/commands/context.ts`, `src/commands/export.ts`
- Delete: `src/commands/.gitkeep`

- [ ] **Step 1: Implement `src/commands/init.ts`**

```typescript
import { Command } from '@oclif/core';
import { runInit } from '../core/run-init.js';

export default class Init extends Command {
  static description = 'Initialize Sensei in the current repo (.sensei/ config + agent rules).';

  async run(): Promise<void> {
    const { created } = runInit(process.cwd());
    if (created.length === 0) {
      this.log('Sensei already initialized. Nothing to do.');
    } else {
      this.log('Initialized Sensei:');
      for (const c of created) this.log(`  + ${c}`);
    }
    this.log('Next: run `sensei scan`.');
  }
}
```

- [ ] **Step 2: Implement `src/commands/scan.ts`**

```typescript
import { Command } from '@oclif/core';
import { runScan } from '../core/run-scan.js';

export default class Scan extends Command {
  static description = 'Scan the repo and build the local symbol index.';

  async run(): Promise<void> {
    const result = await runScan(process.cwd());
    this.log(`Scanned ${result.fileCount} files (${result.changed} changed), indexed ${result.symbolCount} symbols.`);
    if (result.warnings.length) {
      this.log(`Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) this.log(`  ! ${w}`);
    }
    this.log('Next: run `sensei context "<your task>"`.');
  }
}
```

- [ ] **Step 3: Implement `src/commands/context.ts`**

```typescript
import { Args, Command } from '@oclif/core';
import { runContext } from '../core/run-context.js';
import { contextMdPath } from '../paths.js';

export default class Context extends Command {
  static description = 'Build a reuse/context report for a described task.';
  static args = {
    task: Args.string({ description: 'Description of the task you are about to do', required: true }),
  };
  static examples = ['<%= config.bin %> context "add password reset to auth"'];

  async run(): Promise<void> {
    const { args } = await this.parse(Context);
    const report = await runContext(process.cwd(), args.task);
    this.log(`Context for: ${report.task}`);
    this.log(`  ${report.reuseCandidates.length} reuse candidate(s), ${report.dangerousFiles.length} file(s) to avoid editing.`);
    for (const c of report.reuseCandidates.slice(0, 5)) {
      this.log(`  • ${c.path}:${c.line} ${c.name} (${c.score.toFixed(2)})`);
    }
    this.log(`Full report: ${contextMdPath(process.cwd())}`);
    this.log('Export for an agent: `sensei export --target claude`.');
  }
}
```

- [ ] **Step 4: Implement `src/commands/export.ts`**

```typescript
import { Command, Flags } from '@oclif/core';
import { runExport } from '../core/run-export.js';

export default class Export extends Command {
  static description = 'Export the latest context report for an AI agent.';
  static flags = {
    target: Flags.string({ char: 't', description: 'Export target', options: ['claude', 'cursor', 'codex'], default: 'claude' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Export);
    this.log(runExport(process.cwd(), flags.target));
  }
}
```

- [ ] **Step 5: Remove the placeholder and build**

```bash
git rm src/commands/.gitkeep
pnpm build
```
Expected: build exits 0, `dist/commands/` contains `init.js`, `scan.js`, `context.js`, `export.js`.

- [ ] **Step 6: Smoke-test the CLI against itself**

```bash
node ./bin/run.js --help
node ./bin/run.js init
node ./bin/run.js scan
node ./bin/run.js context "add login with password"
node ./bin/run.js export --target claude
```
Expected: `--help` lists init/scan/context/export; `init` creates `.sensei/`; `scan` reports files+symbols; `context` prints candidates including `login`; `export` prints the `=== SENSEI CONTEXT ===` block. (Run on the sensei repo itself.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire oclif commands (init/scan/context/export)"
```

---

## Task 14: End-to-end test

**Files:**
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the e2e test `test/e2e.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';
import { runExport } from '../src/core/run-export.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');
let work: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-e2e-'));
  fs.cpSync(fixture, work, { recursive: true });
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe('end-to-end: init -> scan -> context -> export', () => {
  it('produces a ranked, deterministic report and a Claude export', async () => {
    runInit(work);
    expect(fs.existsSync(path.join(work, '.sensei', 'sensei.config.json'))).toBe(true);
    expect(fs.existsSync(path.join(work, '.sensei', 'agent-rules.md'))).toBe(true);

    const scan = await runScan(work);
    expect(scan.symbolCount).toBeGreaterThan(0);

    const report = await runContext(work, 'add login with password', new Date('2026-06-16T00:00:00Z'));
    expect(report.reuseCandidates[0].name).toBe('login');
    expect(report.reuseCandidates.length).toBeLessThanOrEqual(10);
    expect(fs.existsSync(path.join(work, '.sensei', 'current-task-context.md'))).toBe(true);
    expect(fs.existsSync(path.join(work, '.sensei', 'reuse-candidates.json'))).toBe(true);

    // determinism: re-run yields identical ranking
    const again = await runContext(work, 'add login with password', new Date('2026-06-16T00:00:00Z'));
    expect(again.reuseCandidates.map((c) => c.name)).toEqual(report.reuseCandidates.map((c) => c.name));

    const exported = runExport(work, 'claude');
    expect(exported).toContain('REUSE THESE');
    expect(exported).toContain('login');

    expect(() => runExport(work, 'cursor')).toThrow(/not implemented yet/);
  });

  it('context errors clearly before a scan exists', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-fresh-'));
    await expect(runContext(fresh, 'anything')).rejects.toThrow(/Run `sensei scan` first/);
    fs.rmSync(fresh, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green (tokenize, config, indexer-db, scanner, ast, index-repo, search, scorer, report, exporter, e2e, scaffold).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test: add end-to-end init/scan/context/export coverage"
```

---

## Task 15: README + finalize

**Files:**
- Create: `README.md`
- Modify: remove `test/scaffold.test.ts` (superseded by real tests)

- [ ] **Step 1: Delete the scaffold smoke test**

```bash
git rm test/scaffold.test.ts
```

- [ ] **Step 2: Create `README.md`**

````markdown
# Sensei

> Before your AI agent writes code, Sensei tells it what already exists, what to reuse, and what not to touch.

Sensei is a local-first, deterministic CLI for TypeScript/JavaScript repos. It scans your code into a local SQLite symbol index, then produces a ranked "context report" for any task you describe: which existing functions to reuse, and which high-impact files not to casually edit.

## Install (local dev)

```bash
pnpm install
pnpm build
```

## Usage

```bash
sensei init                          # create .sensei/ (config + agent rules)
sensei scan                          # build the local symbol index
sensei context "add password reset"  # write .sensei/current-task-context.md + reuse-candidates.json
sensei export --target claude        # print a Claude-ready context block
```

## How it works

1. `scan` walks the repo (respecting `.gitignore`), parses TS/JS with `ts-morph`, and indexes symbols + the import graph into `.sensei/cache.db` (SQLite + FTS5). Re-scans are incremental via per-file content hashing.
2. `context` tokenizes your task, retrieves candidate symbols via FTS5, and scores them with a deterministic heuristic (name/signature overlap, path/domain match, exported, git-recency, tests-nearby). It also flags high-fan-in "do not touch" files.
3. `export` renders the latest report for an AI agent.

No API key. No network. Same repo + same task = same ranking.

## Configuration

`.sensei/sensei.config.json` controls include/ignore globs, `context.topN`, scoring weights, and the dangerous-file `importerThreshold`.

## Status

MVP (thin vertical slice). Planned next: `guard` / `validate-plan` / `validate-diff`, embeddings, multi-language, and Cursor/Codex exporters.
````

- [ ] **Step 3: Run the full suite once more**

Run: `pnpm test`
Expected: PASS (scaffold test now gone; all real suites green).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add README; remove scaffold placeholder test"
```

---

## Self-Review Checklist (completed during plan authoring)

**Spec coverage:**
- `init`/`scan`/`context`/`export` → Tasks 13 + 12. ✓
- Git-aware scanning → Task 5. ✓
- Basic AST parsing → Task 6. ✓
- JSON + Markdown output → Task 10. ✓
- Local SQLite cache (FTS5) → Tasks 4, 7. ✓
- Claude-ready export → Task 11. ✓
- Reuse candidates / dangerous files / agent rules → Tasks 9, 10. ✓
- Incremental scan via hashing → Task 7. ✓
- Deterministic output invariant → Tasks 9, 14. ✓
- Error at boundaries (skip-and-warn, clear "run scan first") → Tasks 7, 12, 14. ✓
- Out-of-scope items (guard/validate/embeddings/cursor/codex) correctly deferred; cursor/codex stubbed with explicit errors → Task 12. ✓

**Type consistency:** `ScannedFile`, `ExtractedSymbol`, `ExtractedImport`, `FileExtraction`, `ReuseCandidate`, `DangerousFile`, `ContextReport` defined once in `src/types.ts` and reused. `IndexDb`/`FileRow`/`SymbolHitRow` defined in `db.ts`, imported by scorer/search. `SenseiConfig` from `config/schema.ts`. Function names (`runInit/runScan/runContext/runExport`, `scanRepo`, `extractFromSource`, `indexFiles`, `scoreCandidates`, `findDangerousFiles`, `buildReport`/`renderMarkdown`/`writeReport`, `renderClaude`) are consistent across tasks and tests. ✓

**Placeholder scan:** no TBD/TODO; every code step contains complete code. ✓
