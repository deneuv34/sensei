import { Query } from 'web-tree-sitter';
import type { FileExtraction, ExtractedSymbol, Lang } from '../../types.js';
import { getParser, getLanguage } from './runtime.js';
import { registry } from './registry.js';

const queryCache = new Map<Lang, Query>();

function queryFor(lang: Lang): Query | undefined {
  const cached = queryCache.get(lang);
  if (cached) return cached;
  const language = getLanguage(lang);
  const spec = registry[lang];
  if (!language || !spec) return undefined;
  const q = new Query(language, spec.query);
  queryCache.set(lang, q);
  return q;
}

export function extractTreeSitter(lang: Lang, source: string): FileExtraction {
  const parser = getParser(lang);
  const spec = registry[lang];
  const query = queryFor(lang);
  if (!parser || !spec || !query) return { symbols: [], imports: [] }; // cold/unknown: safe no-op

  const tree = parser.parse(source);
  if (!tree) return { symbols: [], imports: [] };

  const seen = new Set<number>();
  const symbols: ExtractedSymbol[] = [];
  for (const match of query.matches(tree.rootNode)) {
    for (const cap of match.captures) {
      if (cap.name !== 'symbol' || seen.has(cap.node.id)) continue;
      seen.add(cap.node.id);
      const sym = spec.toSymbol(cap.node, source);
      if (sym) symbols.push(sym);
    }
  }
  return { symbols, imports: [] };
}
