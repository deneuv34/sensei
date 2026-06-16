import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { scanRepo } from '../scanner/scan.js';
import { IndexDb } from '../indexer/db.js';
import { indexFiles, type IndexResult } from '../indexer/index-repo.js';
import { dbPath, senseiDir } from '../paths.js';
import { warmup } from '../ast/treesitter/runtime.js';
import { isTreeSitterLang } from '../lang.js';
import { noopProgress, type ProgressFn } from './progress.js';

export async function runScan(cwd: string, onProgress: ProgressFn = noopProgress): Promise<IndexResult> {
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  const config = loadConfig(cwd);
  const files = await scanRepo(cwd, config, onProgress);
  const db = new IndexDb(dbPath(cwd));
  try {
    db.migrate();
    const tsLangs = [...new Set(files.map((f) => f.lang))].filter(isTreeSitterLang);
    const warmWarnings = await warmup(tsLangs);
    const result = indexFiles(db, cwd, files, onProgress);
    result.warnings.push(...warmWarnings);
    db.setMeta('schema_version', '1');
    db.setMeta('last_scan', new Date().toISOString());
    return result;
  } finally {
    db.close();
  }
}
