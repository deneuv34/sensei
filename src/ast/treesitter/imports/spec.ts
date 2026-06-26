import type { Node } from 'web-tree-sitter';
import type { ExtractedImport, Lang } from '../../../types.js';

export interface ImportExtractor {
  lang: Lang;
  /** Walk the parsed root node and return import edges in the shared format. */
  extractImports(root: Node, source: string): ExtractedImport[];
  /** Resolve a module specifier to 0, 1, or many repo-relative file paths. */
  resolveImport(importerPath: string, moduleSpec: string, known: Set<string>): string[];
}
