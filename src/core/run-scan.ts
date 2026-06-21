import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { scanRepo } from '../scanner/scan.js';
import { IndexDb } from '../indexer/db.js';
import { indexFiles, type IndexResult } from '../indexer/index-repo.js';
import { dbPath, senseiDir, modelsDir } from '../paths.js';
import { warmup } from '../ast/treesitter/runtime.js';
import { isTreeSitterLang } from '../lang.js';
import { warmupEmbedder, embed, EmbeddingsUnavailable, EMBEDDING_MODEL } from '../embed/model.js';
import { noopProgress, type ProgressFn } from './progress.js';

const EMBED_CHUNK = 256; // ponytail: bound peak memory; raise if throughput matters

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
    await embedSymbols(db, cwd, result);
    db.setMeta('schema_version', '1');
    db.setMeta('last_scan', new Date().toISOString());
    return result;
  } finally {
    db.close();
  }
}

/** Embed any symbols that lack a vector. Incremental (cascade deletes free changed ones). */
async function embedSymbols(db: IndexDb, cwd: string, result: IndexResult): Promise<void> {
  // A model change invalidates every stored vector.
  const storedModel = db.getMeta('embedding_model');
  if (storedModel && storedModel !== EMBEDDING_MODEL) {
    db.clearEmbeddings();
  }
  const missing = db.symbolsMissingEmbeddings();
  if (missing.length === 0) return;

  try {
    fs.mkdirSync(modelsDir(cwd), { recursive: true });
    await warmupEmbedder(modelsDir(cwd));
    for (let i = 0; i < missing.length; i += EMBED_CHUNK) {
      const batch = missing.slice(i, i + EMBED_CHUNK);
      const vecs = await embed(batch.map((m) => `${m.name} ${m.signature} ${m.jsdoc}`.trim()));
      const tx = db.raw.transaction(() => {
        batch.forEach((m, j) => db.insertEmbedding(m.symbol_id, vecs[j]));
      });
      tx();
    }
    db.setMeta('embedding_model', EMBEDDING_MODEL);
  } catch (err) {
    if (!(err instanceof EmbeddingsUnavailable)) throw err;
    result.warnings.push(`embeddings unavailable: ${err.message}; continuing lexical-only`);
  }
}
