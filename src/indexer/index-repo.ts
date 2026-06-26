import fs from 'node:fs';
import path from 'node:path';
import { IndexDb } from './db.js';
import { resolveImports } from './resolve.js';
import { extractFromSource } from '../ast/extract.js';
import type { ScannedFile } from '../types.js';
import { noopProgress, type ProgressFn } from '../core/progress.js';

export interface IndexResult {
  fileCount: number;
  symbolCount: number;
  changed: number;
  warnings: string[];
}

export function indexFiles(
  db: IndexDb,
  cwd: string,
  files: ScannedFile[],
  onProgress: ProgressFn = noopProgress,
): IndexResult {
  const warnings: string[] = [];
  let changed = 0;

  const tx = db.raw.transaction(() => {
    db.deleteFilesNotIn(files.map((f) => f.path));

    for (const f of files) {
      const existing = db.getFileByPath(f.path);
      const fileId = db.upsertFile(f);
      if (existing && existing.hash === f.hash) continue; // unchanged: skip re-parse
      changed++;
      onProgress({ phase: 'parse', done: changed, total: files.length, detail: f.path });

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

    // Resolve the import graph (multi-target: package imports fan out to files)
    const idByPath = db.fileIdByPath();
    const known = new Set(idByPath.keys());
    // Snapshot once: cloned rows added mid-loop must not be re-iterated (no infinite resolution).
    const imports = db.allImports();
    for (const imp of imports) {
      const targets = resolveImports(imp.file_path, imp.module, known);
      if (targets.length === 0) {
        db.setImportResolution(imp.id, null);
        continue;
      }
      const ids = targets.map((t) => idByPath.get(t)).filter((x): x is number => x != null);
      if (ids.length === 0) {
        db.setImportResolution(imp.id, null);
        continue;
      }
      db.setImportResolution(imp.id, ids[0]);
      for (let i = 1; i < ids.length; i++) {
        db.insertResolvedImport(imp.file_id, imp.module, imp.imported_name, ids[i]);
      }
    }
    onProgress({ phase: 'resolve', done: 0, total: 0 });
    db.recomputeImporterCounts();
  });
  tx();

  return { fileCount: files.length, symbolCount: db.countSymbols(), changed, warnings };
}
