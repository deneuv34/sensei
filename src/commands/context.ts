import { Args, Command } from '@oclif/core';
import { runContext } from '../core/run-context.js';
import { contextMdPath } from '../paths.js';

export default class Context extends Command {
  static description = 'Build a reuse/context report for a described task.';
  static args = {
    task: Args.string({ description: 'Description of the task you are about to do', required: true }),
  };
  static examples = ['<%= config.bin %> context "add password reset to auth"'];

  async run(): Promise<void> {
    const { args } = await this.parse(Context);
    const report = await runContext(process.cwd(), args.task);
    this.log(`Context for: ${report.task}`);
    this.log(`  ${report.reuseCandidates.length} reuse candidate(s), ${report.dangerousFiles.length} file(s) to avoid editing.`);
    for (const c of report.reuseCandidates.slice(0, 5)) {
      this.log(`  • ${c.path}:${c.line} ${c.name} (${c.score.toFixed(2)})`);
    }
    this.log(`Full report: ${contextMdPath(process.cwd())}`);
    this.log('Export for an agent: `sensei export --target claude`.');
  }
}
