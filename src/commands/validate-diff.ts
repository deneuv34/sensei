import { Command, Flags } from '@oclif/core';
import { runValidateDiff } from '../core/run-validate-diff.js';
import { renderValidation, type ValidationReport } from '../validate/report.js';
import type { DiffSource } from '../validate/diff.js';
import { lastValidationJsonPath } from '../paths.js';

export default class ValidateDiff extends Command {
  static description = 'Check changed files against the index for duplication and dangerous edits.';
  static examples = [
    '<%= config.bin %> validate-diff',
    '<%= config.bin %> validate-diff --against main --block',
  ];
  static flags = {
    staged: Flags.boolean({ description: 'Check staged changes (default).', default: false }),
    all: Flags.boolean({ description: 'Check all working-tree changes vs HEAD.', default: false }),
    against: Flags.string({ description: 'Check changes in <ref>...HEAD.' }),
    block: Flags.boolean({ description: 'Exit non-zero if any finding.', default: false }),
    json: Flags.boolean({ description: 'Emit the JSON report.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ValidateDiff);
    const source: DiffSource = flags.against
      ? { mode: 'against', ref: flags.against }
      : flags.all
        ? { mode: 'all' }
        : { mode: 'staged' };

    let report: ValidationReport;
    try {
      report = await runValidateDiff(process.cwd(), source, { block: flags.block || undefined });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    }

    if (flags.json) {
      this.log(JSON.stringify(report, null, 2));
    } else {
      this.log(renderValidation(report));
      this.log(`Report: ${lastValidationJsonPath(process.cwd())}`);
    }
    if (report.blocked) this.exit(1);
  }
}
