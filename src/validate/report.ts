import { z } from 'zod';
import fs from 'node:fs';
import { senseiDir, lastValidationJsonPath, lastPlanValidationJsonPath } from '../paths.js';

export const FindingKindSchema = z.enum([
  'duplicate-candidate',
  'dangerous-edit',
  'reuse-candidate',
  'dangerous-target',
]);
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

const GROUP_TITLES: ReadonlyArray<readonly [FindingKind, string]> = [
  ['duplicate-candidate', 'DUPLICATE CANDIDATES'],
  ['reuse-candidate', 'REUSE CANDIDATES'],
  ['dangerous-edit', 'DANGEROUS EDITS'],
  ['dangerous-target', 'DANGEROUS TARGETS'],
];

export function renderValidation(report: ValidationReport): string {
  if (report.findings.length === 0) return 'No findings.';
  const groups = GROUP_TITLES
    .map(([kind, title]) => renderGroup(title, report.findings.filter((f) => f.kind === kind)))
    .filter((g) => g.length > 0);
  const lines = groups.flatMap((g, i) => (i === 0 ? g : ['', ...g]));
  if (report.blocked) lines.push('', `BLOCKED: ${report.findings.length} finding(s).`);
  return lines.join('\n');
}

function writeReport(targetPath: string, cwd: string, report: ValidationReport): void {
  ValidationReportSchema.parse(report);
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(report, null, 2) + '\n');
}

export function writeValidation(cwd: string, report: ValidationReport): void {
  writeReport(lastValidationJsonPath(cwd), cwd, report);
}

export function writePlanValidation(cwd: string, report: ValidationReport): void {
  writeReport(lastPlanValidationJsonPath(cwd), cwd, report);
}
