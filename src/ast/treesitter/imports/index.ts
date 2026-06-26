import type { Lang } from '../../../types.js';
import type { ImportExtractor } from './spec.js';

export const importExtractors: Partial<Record<Lang, ImportExtractor>> = {};
