import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import { dbPath, modelsDir } from '../paths.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { vectorSearch } from '../search/vector.js';
import { warmupEmbedder, embed, EmbeddingsUnavailable } from '../embed/model.js';
import { scoreCandidates, findDangerousFiles } from '../scorer/score.js';
import { readAgentRules } from '../report/agent-rules.js';
import { buildReport, writeReport } from '../report/build.js';
import type { ContextReport } from '../types.js';

export interface ContextOptions {
  now?: Date;
  write?: boolean;
}

export async function runContext(
  cwd: string,
  task: string,
  opts: ContextOptions = {},
): Promise<ContextReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const db = new IndexDb(dbPath(cwd));
  try {
    const now = opts.now ?? new Date();
    const tokens = tokenize(task);
    let hits = searchSymbols(db, tokens);
    const semanticSim = await semanticSimilarity(db, cwd, task, config.context.vectorTopK);
    if (semanticSim) {
      const known = new Set(hits.map((h) => h.symbol_id));
      const extraIds = [...semanticSim.keys()].filter((id) => !known.has(id));
      if (extraIds.length) hits = hits.concat(db.symbolsByIds(extraIds));
    }
    const ranked = scoreCandidates(hits, tokens, config, db, semanticSim).slice(0, config.context.topN);
    const dangerous = findDangerousFiles(db, config);
    const rules = readAgentRules(cwd);
    const report = buildReport(task, ranked, dangerous, rules, now);
    if (opts.write !== false) writeReport(cwd, report);
    return report;
  } finally {
    db.close();
  }
}

/** Embed the query and return a symbol_id → cosine map, or undefined if embeddings are absent/unavailable. */
async function semanticSimilarity(
  db: IndexDb,
  cwd: string,
  task: string,
  vectorTopK: number,
): Promise<Map<number, number> | undefined> {
  if (db.countEmbeddings() === 0) return undefined;
  try {
    await warmupEmbedder(modelsDir(cwd));
    const [queryVec] = await embed([task]);
    if (!queryVec) return undefined;
    const top = vectorSearch(db, queryVec, vectorTopK);
    return new Map(top.map((t) => [t.symbol_id, t.score]));
  } catch (err) {
    if (!(err instanceof EmbeddingsUnavailable)) throw err;
    return undefined; // lexical-only; scan already warned on the unavailable model
  }
}
