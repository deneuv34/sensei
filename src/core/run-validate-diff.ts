import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import { dbPath } from '../paths.js';
import { changedFiles, type DiffSource } from '../validate/diff.js';
import { introducedSymbols } from '../validate/introduced.js';
import { duplicateFindings, dangerousFindings } from '../validate/checks.js';
import { writeValidation, type Finding, type ValidationReport } from '../validate/report.js';

export interface ValidateOptions {
  block?: boolean;
}

export async function runValidateDiff(
  cwd: string,
  source: DiffSource,
  opts: ValidateOptions = {},
  now: Date = new Date(),
): Promise<ValidationReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const blocking = opts.block ?? config.validate.block;
  const severity: Finding['severity'] = blocking ? 'block' : 'warn';
  const files = await changedFiles(cwd, source);

  const db = new IndexDb(dbPath(cwd));
  try {
    const findings: Finding[] = [];
    if (config.validate.checkDuplicates) {
      for (const file of files) {
        const abs = path.join(cwd, file);
        let content: string;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch {
          continue; // deleted/unreadable in working tree
        }
        const introduced = introducedSymbols(db, file, content);
        findings.push(...duplicateFindings(db, config, file, introduced, severity));
      }
    }
    if (config.validate.checkDangerous) {
      findings.push(...dangerousFindings(db, config, files, severity));
    }

    const sourceLabel = source.mode === 'against' ? source.ref : source.mode;
    const report: ValidationReport = {
      source: sourceLabel,
      generatedAt: now.toISOString(),
      findings,
      blocked: blocking && findings.length > 0,
    };
    writeValidation(cwd, report);
    return report;
  } finally {
    db.close();
  }
}
