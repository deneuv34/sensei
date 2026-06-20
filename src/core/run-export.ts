import fs from 'node:fs';
import path from 'node:path';
import { candidatesJsonPath, cursorRulePath, codexRulePath } from '../paths.js';
import { ContextReportSchema } from '../report/schema.js';
import { renderClaude } from '../exporters/claude.js';
import { renderCursor } from '../exporters/cursor.js';
import { renderCodex } from '../exporters/codex.js';
import { writeManagedSection } from '../exporters/write-section.js';

const TARGETS = ['claude', 'cursor', 'codex'] as const;
export type ExportTarget = (typeof TARGETS)[number];

export interface ExportOptions {
  write?: boolean;
}

export function runExport(cwd: string, target: string, opts: ExportOptions = {}): string {
  if (!fs.existsSync(candidatesJsonPath(cwd))) {
    throw new Error('No context report found. Run `sensei context "<task>"` first.');
  }
  const report = ContextReportSchema.parse(
    JSON.parse(fs.readFileSync(candidatesJsonPath(cwd), 'utf8')),
  );

  if (target === 'claude') {
    if (opts.write) {
      throw new Error(
        '--write is not supported for target "claude" (no canonical native file). Redirect stdout into your rules file instead.',
      );
    }
    return renderClaude(report);
  }

  if (target === 'cursor') {
    const out = renderCursor(report);
    if (!opts.write) return out;
    // dedicated, sensei-owned file: whole-file write keeps MDC frontmatter at the top
    const dest = cursorRulePath(cwd);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${out}\n`);
    return `Wrote Sensei context to ${path.relative(cwd, dest)}`;
  }

  if (target === 'codex') {
    const out = renderCodex(report);
    if (!opts.write) return out;
    // shared file: preserve user content via managed section
    const dest = codexRulePath(cwd);
    writeManagedSection(dest, out);
    return `Wrote Sensei context to ${path.relative(cwd, dest)}`;
  }

  throw new Error(`Unknown export target "${target}". Supported: ${TARGETS.join(', ')}.`);
}
