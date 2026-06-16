import type { IndexDb } from '../indexer/db.js';
import type { SenseiConfig } from '../config/schema.js';
import type { ExtractedSymbol } from '../types.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { findDangerousFiles } from '../scorer/score.js';
import type { Finding, Severity } from './report.js';

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

export function symbolSimilarity(
  a: { name: string; signature: string },
  b: { name: string; signature: string },
): number {
  const nameSim = jaccard(tokenize(a.name), tokenize(b.name));
  const sigSim = jaccard(tokenize(a.signature), tokenize(b.signature));
  return 0.5 * nameSim + 0.5 * sigSim;
}

export function duplicateFindings(
  db: IndexDb,
  config: SenseiConfig,
  changedFile: string,
  introduced: ExtractedSymbol[],
  severity: Severity,
): Finding[] {
  const threshold = config.validate.duplicateThreshold;
  const out: Finding[] = [];
  for (const symbol of introduced) {
    if (tokenize(symbol.name).length === 0) continue; // common-name suppression
    const best = searchSymbols(db, tokenize(`${symbol.name} ${symbol.signature}`))
      .filter((h) => h.path !== changedFile)
      .map((h) => ({
        path: h.path,
        line: h.start_line,
        name: h.name,
        score: symbolSimilarity(symbol, { name: h.name, signature: h.signature }),
      }))
      .filter((r) => r.score >= threshold)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))[0];
    if (!best) continue;
    out.push({
      kind: 'duplicate-candidate',
      severity,
      file: changedFile,
      line: symbol.startLine,
      message: `${symbol.name} closely matches existing ${best.name} at ${best.path}:${best.line} (similarity ${best.score.toFixed(2)}) — reuse instead of reimplementing.`,
      related: best,
    });
  }
  return out;
}

export function dangerousFindings(
  db: IndexDb,
  config: SenseiConfig,
  changedFiles: string[],
  severity: Severity,
): Finding[] {
  const danger = new Map(findDangerousFiles(db, config).map((d) => [d.path, d]));
  const out: Finding[] = [];
  for (const file of changedFiles) {
    const d = danger.get(file);
    if (!d) continue;
    out.push({
      kind: 'dangerous-edit',
      severity,
      file,
      line: 1,
      message: `editing ${file} — ${d.reason} (importer_count ${d.importerCount}).`,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
