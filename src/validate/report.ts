import { z } from 'zod';
import fs from 'node:fs';
import { senseiDir, lastValidationJsonPath } from '../paths.js';

export const FindingKindSchema = z.enum(['duplicate-candidate', 'dangerous-edit']);
export const SeveritySchema = z.enum(['warn', 'block']);

export const RelatedSymbolSchema = z.object({
  path: z.string(),
  line: z.number(),
  name: z.string(),
  score: z.number(),
});

export const FindingSchema = z.object({
  kind: FindingKindSchema,
  severity: SeveritySchema,
  file: z.string(),
  line: z.number(),
  message: z.string(),
  related: RelatedSymbolSchema.optional(),
});

export const ValidationReportSchema = z.object({
  source: z.string(),
  generatedAt: z.string(),
  findings: z.array(FindingSchema),
  blocked: z.boolean(),
});

export type FindingKind = z.infer<typeof FindingKindSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

function renderGroup(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [];
  const lines = [`${title}:`];
  for (const f of findings) lines.push(`  ${f.file}:${f.line} — ${f.message}`);
  return lines;
}

export function renderValidation(report: ValidationReport): string {
  if (report.findings.length === 0) return 'No findings.';
  const dup = report.findings.filter((f) => f.kind === 'duplicate-candidate');
  const dang = report.findings.filter((f) => f.kind === 'dangerous-edit');
  const groups = [renderGroup('DUPLICATE CANDIDATES', dup), renderGroup('DANGEROUS EDITS', dang)]
    .filter((g) => g.length > 0);
  const lines = groups.flatMap((g, i) => (i === 0 ? g : ['', ...g]));
  if (report.blocked) lines.push('', `BLOCKED: ${report.findings.length} finding(s).`);
  return lines.join('\n');
}

export function writeValidation(cwd: string, report: ValidationReport): void {
  ValidationReportSchema.parse(report);
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(lastValidationJsonPath(cwd), JSON.stringify(report, null, 2) + '\n');
}
