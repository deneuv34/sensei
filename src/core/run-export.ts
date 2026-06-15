import fs from 'node:fs';
import { candidatesJsonPath } from '../paths.js';
import { ContextReportSchema } from '../report/schema.js';
import { renderClaude } from '../exporters/claude.js';
import type { ContextReport } from '../types.js';

const TARGETS = ['claude', 'cursor', 'codex'] as const;
export type ExportTarget = (typeof TARGETS)[number];

export function runExport(cwd: string, target: string): string {
  if (!fs.existsSync(candidatesJsonPath(cwd))) {
    throw new Error('No context report found. Run `sensei context "<task>"` first.');
  }
  const parsed = ContextReportSchema.parse(JSON.parse(fs.readFileSync(candidatesJsonPath(cwd), 'utf8')));
  const report = parsed as ContextReport;
  if (target === 'claude') return renderClaude(report);
  if (target === 'cursor' || target === 'codex') {
    throw new Error(`Export target "${target}" is not implemented yet (Phase 2). Use --target claude.`);
  }
  throw new Error(`Unknown export target "${target}". Supported: ${TARGETS.join(', ')}.`);
}
