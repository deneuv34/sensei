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
    const idByPath = db.fileIdByPath();
    const known = new Set(idByPath.keys());
    for (const imp of db.allImports()) {
      const resolved = resolveModule(imp.file_path, imp.module, known);
      db.setImportResolution(imp.id, resolved ? idByPath.get(resolved) ?? null : null);
    }
    db.recomputeImporterCounts();
  });
  tx();

  return { fileCount: files.length, symbolCount: db.countSymbols(), changed, warnings };
}
