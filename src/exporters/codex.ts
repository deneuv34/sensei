import type { ContextReport } from '../types.js';

/** Markdown body shared by the Codex (AGENTS.md) and Cursor (.mdc) exporters. */
export function renderCodex(report: ContextReport): string {
  const lines: string[] = [];
  lines.push(`# Sensei context for: ${report.task}`);
  lines.push('');
  lines.push('## Reuse these (do not reimplement)');
  if (report.reuseCandidates.length === 0) {
    lines.push('- (no strong matches found)');
  } else {
    for (const c of report.reuseCandidates) {
      lines.push(`- \`${c.path}:${c.line}\` ${c.name} — ${c.signature}`);
    }
  }
  lines.push('');
  lines.push('## Do not touch without confirmation (high-impact files)');
  if (report.dangerousFiles.length === 0) {
    lines.push('- (none detected)');
  } else {
    for (const d of report.dangerousFiles) {
      lines.push(`- \`${d.path}\` (${d.reason})`);
    }
  }
  lines.push('');
  lines.push('## Rules');
  for (const r of report.agentRules) lines.push(`- ${r}`);
  return lines.join('\n');
}
