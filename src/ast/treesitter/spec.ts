import type { Node } from 'web-tree-sitter';
import type { ExtractedSymbol, Lang } from '../../types.js';

export interface LangSpec {
  lang: Lang;
  /** .scm query; each declaration node is captured as @symbol. */
  query: string;
  /** Map one captured node to a symbol, or null to skip it. */
  toSymbol(node: Node, source: string): ExtractedSymbol | null;
}
