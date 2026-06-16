import type { Lang } from '../../types.js';
import type { LangSpec } from './spec.js';
import { pythonSpec } from './langs/python.js';
import { goSpec } from './langs/go.js';
import { rustSpec } from './langs/rust.js';
import { javaSpec } from './langs/java.js';

export const registry: Partial<Record<Lang, LangSpec>> = {
  py: pythonSpec,
  go: goSpec,
  rust: rustSpec,
  java: javaSpec,
};
