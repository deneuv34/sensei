import type { ContextReport } from '../types.js';
import { renderCodex } from './codex.js';

const FRONTMATTER = [
  '---',
  'description: Sensei reuse/danger context for the current task',
  'globs: "**/*"',
  'alwaysApply: true',
  '---',
].join('\n');

/** Cursor MDC: YAML frontmatter (must be file-top) then the shared markdown body. */
export function renderCursor(report: ContextReport): string {
  return `${FRONTMATTER}\n${renderCodex(report)}`;
}
