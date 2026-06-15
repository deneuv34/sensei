import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { scanRepo } from '../scanner/scan.js';
import { IndexDb } from '../indexer/db.js';
import { indexFiles, type IndexResult } from '../indexer/index-repo.js';
import { dbPath, senseiDir } from '../paths.js';

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
