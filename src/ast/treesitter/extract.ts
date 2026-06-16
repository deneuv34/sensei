import type { FileExtraction, Lang } from '../../types.js';

export function extractTreeSitter(_lang: Lang, _source: string): FileExtraction {
  return { symbols: [], imports: [] };
}
