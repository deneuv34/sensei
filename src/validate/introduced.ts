import type { IndexDb } from '../indexer/db.js';
import type { ExtractedSymbol } from '../types.js';
import { extractFromSource } from '../ast/extract.js';

const NUL = ' ';
const identity = (s: { kind: string; name: string; signature: string }): string =>
  `${s.kind}${NUL}${s.name}${NUL}${s.signature}`;

export function introducedSymbols(db: IndexDb, filePath: string, source: string): ExtractedSymbol[] {
  const known = new Set(db.symbolsForFile(filePath).map(identity));
  const { symbols } = extractFromSource(filePath, source);
  return symbols.filter((s) => !known.has(identity(s)));
}
