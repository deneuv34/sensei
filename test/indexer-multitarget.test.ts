import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexDb } from '../src/indexer/db.js';
import { indexFiles } from '../src/indexer/index-repo.js';
import { importExtractors } from '../src/ast/treesitter/imports/index.js';
import type { ImportExtractor } from '../src/ast/treesitter/imports/spec.js';
import type { FileExtraction, ScannedFile } from '../src/types.js';

// Stub the parse phase so the importer file gets exactly one import edge
// regardless of whether the python tree-sitter grammar is warmed up. The
// resolve phase is exercised via the real importExtractors['py'] stub below.
vi.mock('../src/ast/extract.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/ast/extract.js');
  return {
    ...actual,
    extractFromSource: vi.fn((filePath: string, _source: string): FileExtraction => {
      if (filePath === 'pkg/auth.py') {
        return {
          symbols: [],
          imports: [{ module: 'pkg.auth', importedName: '*' }],
        };
      }
      return { symbols: [], imports: [] };
    }),
  };
});

const pyStub: ImportExtractor = {
  lang: 'py',
  extractImports: () => [{ module: 'pkg.auth', importedName: '*' }],
  resolveImport: (_importerPath: string, _moduleSpec: string, known: Set<string>): string[] => {
    return ['pkg/token.py', 'pkg/secret.py'].filter((p) => known.has(p));
  },
};

function file(over: Partial<ScannedFile>): ScannedFile {
  return {
    path: 'pkg/auth.py',
    hash: 'h1',
    lang: 'py',
    loc: 1,
    gitLastModified: null,
    gitCommitCount: 0,
    ...over,
  };
}

function countClones(db: IndexDb): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM imports WHERE is_clone = 1').get() as { n: number }).n;
}

function importsForFile(
  db: IndexDb,
  fileId: number,
): Array<{ resolved_file_id: number | null; is_clone: number }> {
  return db.raw
    .prepare('SELECT resolved_file_id, is_clone FROM imports WHERE file_id = ? ORDER BY id')
    .all(fileId) as Array<{ resolved_file_id: number | null; is_clone: number }>;
}

describe('indexFiles multi-target cloning', () => {
  let tmp = '';

  afterEach(() => {
    delete importExtractors['py'];
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('clones an import row for each additional resolved target and stays idempotent across re-indexes', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-mt-'));
    // Write source files so indexFiles' readFileSync succeeds. Contents don't
    // matter — extractFromSource is mocked.
    fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pkg', 'auth.py'), 'from pkg import auth\n');
    fs.writeFileSync(path.join(tmp, 'pkg', 'token.py'), 'TOKEN = 1\n');
    fs.writeFileSync(path.join(tmp, 'pkg', 'secret.py'), 'SECRET = 1\n');

    const db = new IndexDb(':memory:');
    db.migrate();

    const importer = file({ path: 'pkg/auth.py', hash: 'h1' });
    const targetA = file({ path: 'pkg/token.py', hash: 'h2' });
    const targetB = file({ path: 'pkg/secret.py', hash: 'h3' });
    const files: ScannedFile[] = [importer, targetA, targetB];

    importExtractors['py'] = pyStub;

    const result = indexFiles(db, tmp, files);
    expect(result.warnings).toEqual([]);

    const importerId = db.getFileByPath('pkg/auth.py')!.id;
    const tokenId = db.getFileByPath('pkg/token.py')!.id;
    const secretId = db.getFileByPath('pkg/secret.py')!.id;

    const rows = importsForFile(db, importerId);
    // One original + one clone.
    expect(rows).toHaveLength(2);
    expect(rows[0].is_clone).toBe(0);
    expect(rows[0].resolved_file_id).toBe(tokenId);
    expect(rows[1].is_clone).toBe(1);
    expect(rows[1].resolved_file_id).toBe(secretId);

    expect(countClones(db)).toBe(1);

    // recomputeImporterCounts ran: both targets have importer_count >= 1.
    expect(db.getFileByPath('pkg/token.py')!.importer_count).toBeGreaterThanOrEqual(1);
    expect(db.getFileByPath('pkg/secret.py')!.importer_count).toBeGreaterThanOrEqual(1);

    // Idempotency: a second run with unchanged files must NOT double the clones.
    // Unchanged files skip re-parse, but the resolve phase clears+rebuilds clones.
    const second = indexFiles(db, tmp, files);
    expect(second.changed).toBe(0);
    expect(countClones(db)).toBe(1);
    expect(importsForFile(db, importerId)).toHaveLength(2);

    db.close();
  });
});
