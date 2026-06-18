import type { Lang } from './types.js';

export function langOfPath(p: string): Lang {
  if (p.endsWith('.tsx')) return 'tsx';
  if (p.endsWith('.ts')) return 'ts';
  if (p.endsWith('.jsx')) return 'jsx';
  if (p.endsWith('.py')) return 'py';
  if (p.endsWith('.go')) return 'go';
  if (p.endsWith('.rs')) return 'rust';
  if (p.endsWith('.java')) return 'java';
  return 'js';
}

export const TREE_SITTER_LANGS: Lang[] = ['py', 'go', 'rust', 'java'];

export function isTreeSitterLang(l: Lang): boolean {
  return l === 'py' || l === 'go' || l === 'rust' || l === 'java';
}
