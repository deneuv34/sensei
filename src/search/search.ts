import type { IndexDb, SymbolHitRow } from '../indexer/db.js';

/** Build a safe FTS5 MATCH expression: OR of quoted tokens. */
export function buildMatchExpr(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export function searchSymbols(db: IndexDb, tokens: string[], limit = 200): SymbolHitRow[] {
  if (tokens.length === 0) return [];
  return db.searchSymbols(buildMatchExpr(tokens), limit);
}
