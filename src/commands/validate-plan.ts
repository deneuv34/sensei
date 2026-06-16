import fs from 'node:fs';
import { Args, Command, Flags } from '@oclif/core';
import { runValidatePlan } from '../core/run-validate-plan.js';
import { renderValidation, type ValidationReport } from '../validate/report.js';
import { lastPlanValidationJsonPath } from '../paths.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export default class ValidatePlan extends Command {
  static description = 'Check an agent plan against the index for reuse violations and dangerous targets.';
  static examples = [
    '<%= config.bin %> validate-plan plan.md',
    'cat plan.md | <%= config.bin %> validate-plan --stdin --block',
  ];
  static args = {
    plan: Args.string({ description: 'Path to the plan markdown file.', required: false }),
  };
  static flags = {
    stdin: Flags.boolean({ description: 'Read the plan from stdin instead of a file.', default: false }),
    block: Flags.boolean({ description: 'Exit non-zero if any finding.', default: false }),
    json: Flags.boolean({ description: 'Emit the JSON report.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ValidatePlan);

    let planText: string;
    try {
      if (flags.stdin) {
        planText = await readStdin();
      } else if (args.plan) {
        planText = fs.readFileSync(args.plan, 'utf8');
      } else {
        this.error('Provide a plan file path or use --stdin.', { exit: 2 });
      }
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    }

    let report: ValidationReport;
    try {
      report = await runValidatePlan(process.cwd(), planText, { block: flags.block || undefined });
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 2 });
    }

    if (flags.json) {
      this.log(JSON.stringify(report, null, 2));
    } else {
      this.log(renderValidation(report));
      this.log(`Report: ${lastPlanValidationJsonPath(process.cwd())}`);
    }
    if (report.blocked) this.exit(1);
  }
}
