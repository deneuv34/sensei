import fs from 'node:fs';
import { loadConfig } from '../config/load.js';
import { IndexDb } from '../indexer/db.js';
import { dbPath } from '../paths.js';
import { parsePlan } from '../validate/plan-parse.js';
import { runPlanChecks } from '../validate/plan-checks.js';
import { writePlanValidation, type Finding, type ValidationReport } from '../validate/report.js';

export interface ValidatePlanOptions {
  block?: boolean;
}

export async function runValidatePlan(
  cwd: string,
  planText: string,
  opts: ValidatePlanOptions = {},
  now: Date = new Date(),
): Promise<ValidationReport> {
  if (!fs.existsSync(dbPath(cwd))) {
    throw new Error('No index found. Run `sensei scan` first.');
  }
  const config = loadConfig(cwd);
  const blocking = opts.block ?? config.validate.block;
  const severity: Finding['severity'] = blocking ? 'block' : 'warn';
  const targets = parsePlan(planText);

  const db = new IndexDb(dbPath(cwd));
  try {
    const findings = runPlanChecks({ targets, db, config, severity });
    const report: ValidationReport = {
      source: 'plan',
      generatedAt: now.toISOString(),
      findings,
      blocked: blocking && findings.length > 0,
    };
    writePlanValidation(cwd, report);
    return report;
  } finally {
    db.close();
  }
}
