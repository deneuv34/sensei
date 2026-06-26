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
  resolved_file_id INTEGER,
  is_clone INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, signature, jsdoc, path);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS embeddings (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  vec BLOB NOT NULL
);
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
    try {
      this.raw.exec('ALTER TABLE imports ADD COLUMN is_clone INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
      // Column already exists (older caches already migrated) — ignore.
      if (!String((err as Error).message).includes('duplicate column name')) throw err;
    }
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

  allImports(): Array<{ id: number; file_id: number; file_path: string; module: string; imported_name: string }> {
    return this.raw
      .prepare('SELECT i.id, i.file_id, f.path AS file_path, i.module, i.imported_name FROM imports i JOIN files f ON f.id = i.file_id')
      .all() as Array<{ id: number; file_id: number; file_path: string; module: string; imported_name: string }>;
  }

  setImportResolution(importId: number, resolvedFileId: number | null): void {
    this.raw.prepare('UPDATE imports SET resolved_file_id = ? WHERE id = ?').run(resolvedFileId, importId);
  }

  /** Clone an import row to attribute it to an additional resolved file (package-level imports). */
  insertResolvedImport(fileId: number, module: string, importedName: string, resolvedFileId: number): void {
    this.raw
      .prepare('INSERT INTO imports (file_id, module, imported_name, resolved_file_id, is_clone) VALUES (?, ?, ?, ?, 1)')
      .run(fileId, module, importedName, resolvedFileId);
  }

  /** Drop all clone rows so the resolve phase can rebuild them idempotently each scan. */
  clearCloneImports(): void {
    this.raw.exec('DELETE FROM imports WHERE is_clone = 1');
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

  symbolsForFile(path: string): Array<{ name: string; kind: string; signature: string }> {
    return this.raw
      .prepare(
        `SELECT s.name, s.kind, s.signature
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE f.path = ?
         ORDER BY s.start_line`,
      )
      .all(path) as Array<{ name: string; kind: string; signature: string }>;
  }

  mtimeStats(): { min: number | null; max: number | null } {
    return this.raw
      .prepare(
        'SELECT MIN(git_last_modified) AS min, MAX(git_last_modified) AS max FROM files WHERE git_last_modified IS NOT NULL',
      )
      .get() as { min: number | null; max: number | null };
  }

  countSymbols(): number {
    return (this.raw.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;
  }

  // Vectors are stored native-endian; .sensei/cache.db is a local, rebuildable cache (not portable across endianness).
  insertEmbedding(symbolId: number, vec: Float32Array): void {
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.raw
      .prepare('INSERT OR REPLACE INTO embeddings (symbol_id, vec) VALUES (?, ?)')
      .run(symbolId, blob);
  }

  allEmbeddings(): Array<{ symbol_id: number; vec: Float32Array }> {
    const rows = this.raw
      .prepare('SELECT symbol_id, vec FROM embeddings')
      .all() as Array<{ symbol_id: number; vec: Buffer }>;
    return rows.map((r) => {
      const copy = r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength);
      return { symbol_id: r.symbol_id, vec: new Float32Array(copy) };
    });
  }

  countEmbeddings(): number {
    return (this.raw.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
  }

  symbolsMissingEmbeddings(): Array<{ symbol_id: number; name: string; signature: string; jsdoc: string }> {
    return this.raw
      .prepare(
        `SELECT s.id AS symbol_id, s.name, s.signature, s.jsdoc
         FROM symbols s
         LEFT JOIN embeddings e ON e.symbol_id = s.id
         WHERE e.symbol_id IS NULL
         ORDER BY s.id`,
      )
      .all() as Array<{ symbol_id: number; name: string; signature: string; jsdoc: string }>;
  }

  symbolsByIds(ids: number[]): SymbolHitRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.raw
      .prepare(
        `SELECT s.id AS symbol_id, s.file_id, f.path, s.kind, s.name, s.signature,
                s.exported, s.start_line, s.jsdoc, f.git_last_modified
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.id IN (${placeholders})`,
      )
      .all(...ids) as SymbolHitRow[];
  }

  clearEmbeddings(): void {
    this.raw.exec('DELETE FROM embeddings');
  }

  close(): void {
    this.raw.close();
  }
}
