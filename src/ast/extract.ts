import type { FileExtraction } from '../types.js';
import { langOfPath, isTreeSitterLang } from '../lang.js';
import { extractTs } from './extract-ts.js';
import { extractTreeSitter } from './treesitter/extract.js';

export function extractFromSource(filePath: string, source: string): FileExtraction {
  const lang = langOfPath(filePath);
  if (isTreeSitterLang(lang)) return extractTreeSitter(lang, source);
  return extractTs(filePath, source);
}
