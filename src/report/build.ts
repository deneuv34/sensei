import fs from 'node:fs';
import type { ContextReport, ReuseCandidate, DangerousFile } from '../types.js';
import { ContextReportSchema } from './schema.js';
import { senseiDir, contextMdPath, candidatesJsonPath } from '../paths.js';

export function buildReport(
  task: string,
  reuseCandidates: ReuseCandidate[],
  dangerousFiles: DangerousFile[],
  agentRules: string[],
  now: Date = new Date(),
): ContextReport {
  return { task, generatedAt: now.toISOString(), reuseCandidates, dangerousFiles, agentRules };
}

export function renderMarkdown(report: ContextReport): string {
  const lines: string[] = [];
  lines.push('# Sensei Context');
  lines.push('');
  lines.push(`**Task:** ${report.task}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push('');

  lines.push('## Reuse first — existing code that may already do this');
  lines.push('');
  if (report.reuseCandidates.length === 0) {
    lines.push('_No strong matches found._');
  } else {
    for (const c of report.reuseCandidates) {
      lines.push(`- \`${c.path}:${c.line}\` — **${c.name}** \`${c.signature}\` (score ${c.score.toFixed(2)})`);
      if (c.reasons.length) lines.push(`  - ${c.reasons.join('; ')}`);
    }
  }
  lines.push('');

  lines.push('## Do not casually edit — high-impact / entrypoint files');
  lines.push('');
  if (report.dangerousFiles.length === 0) {
    lines.push('_None detected._');
  } else {
    for (const d of report.dangerousFiles) lines.push(`- \`${d.path}\` — ${d.reason}`);
  }
  lines.push('');

  lines.push('## Agent rules');
  lines.push('');
  if (report.agentRules.length === 0) {
    lines.push('_No rules defined._');
  } else {
    for (const r of report.agentRules) lines.push(`- ${r}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeReport(cwd: string, report: ContextReport): void {
  ContextReportSchema.parse(report); // validate shape; throws on invalid data
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(contextMdPath(cwd), renderMarkdown(report));
  fs.writeFileSync(candidatesJsonPath(cwd), JSON.stringify(report, null, 2) + '\n');
}
