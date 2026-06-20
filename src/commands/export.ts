import { Command, Flags } from '@oclif/core';
import { runExport } from '../core/run-export.js';

export default class Export extends Command {
  static description = 'Export the latest context report for an AI agent.';
  static flags = {
    target: Flags.string({ char: 't', description: 'Export target', options: ['claude', 'cursor', 'codex'], default: 'claude' }),
    write: Flags.boolean({ char: 'w', description: "Write into the target's native rule file (cursor/codex only)", default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Export);
    this.log(runExport(process.cwd(), flags.target, { write: flags.write }));
  }
}
