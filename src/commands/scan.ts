import { Command } from '@oclif/core';
import { runScan } from '../core/run-scan.js';

export default class Scan extends Command {
  static description = 'Scan the repo and build the local symbol index.';

  async run(): Promise<void> {
    const result = await runScan(process.cwd());
    this.log(`Scanned ${result.fileCount} files (${result.changed} changed), indexed ${result.symbolCount} symbols.`);
    if (result.warnings.length) {
      this.log(`Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) this.log(`  ! ${w}`);
    }
    this.log('Next: run `sensei context "<your task>"`.');
  }
}
