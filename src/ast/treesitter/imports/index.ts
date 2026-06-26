import type { Lang } from '../../../types.js';
import type { ImportExtractor } from './spec.js';
import { pythonImports } from './python.js';

export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {
  py: pythonImports,
};
