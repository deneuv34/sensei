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
    const hits = searchSymbols(db, tokens);
    const ranked = scoreCandidates(hits, tokens, config, db).slice(0, config.context.topN);
    const dangerous = findDangerousFiles(db, config);
    const rules = readAgentRules(cwd);
    const report = buildReport(task, ranked, dangerous, rules, now);
    if (opts.write !== false) writeReport(cwd, report);
    return report;
  } finally {
    db.close();
  }
}
