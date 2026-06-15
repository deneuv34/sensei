import type { ContextReport } from '../types.js';

export function renderClaude(report: ContextReport): string {
  const lines: string[] = [];
  lines.push('=== SENSEI CONTEXT (read before writing code) ===');
  lines.push(`Task: ${report.task}`);
  lines.push('');
  lines.push('## REUSE THESE (do not reimplement):');
  if (report.reuseCandidates.length === 0) {
    lines.push('- (no strong matches found)');
  } else {
    for (const c of report.reuseCandidates) {
      lines.push(`- ${c.path}:${c.line} ${c.name} — ${c.signature}`);
    }
  }
  lines.push('');
  lines.push('## DO NOT TOUCH without confirmation (high-impact files):');
  if (report.dangerousFiles.length === 0) {
    lines.push('- (none detected)');
  } else {
    for (const d of report.dangerousFiles) lines.push(`- ${d.path} (${d.reason})`);
  }
  lines.push('');
  lines.push('## RULES:');
  for (const r of report.agentRules) lines.push(`- ${r}`);
  lines.push('=== END SENSEI CONTEXT ===');
  return lines.join('\n');
}
