import { Command } from '@oclif/core';
import { runInit } from '../core/run-init.js';

export default class Init extends Command {
  static description = 'Initialize Sensei in the current repo (.sensei/ config + agent rules).';

  async run(): Promise<void> {
    const { created } = runInit(process.cwd());
    if (created.length === 0) {
      this.log('Sensei already initialized. Nothing to do.');
    } else {
      this.log('Initialized Sensei:');
      for (const c of created) this.log(`  + ${c}`);
    }
    this.log('Next: run `sensei scan`.');
  }
}
