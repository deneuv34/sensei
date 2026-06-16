import type { Lang } from '../../types.js';
import type { LangSpec } from './spec.js';
import { pythonSpec } from './langs/python.js';

export const registry: Partial<Record<Lang, LangSpec>> = {
  py: pythonSpec,
};
