import type { Lang } from '../../../types.js';
import type { ImportExtractor } from './spec.js';
import { pythonImports } from './python.js';
import { goImports } from './go.js';
import { rustImports } from './rust.js';

export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {
  py: pythonImports,
  go: goImports,
  rust: rustImports,
};
