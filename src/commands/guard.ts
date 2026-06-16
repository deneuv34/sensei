import { Args, Command, Flags } from '@oclif/core';
import { runGuard, type GuardAction } from '../core/run-guard.js';
import type { HookName } from '../guard/hook.js';

export default class Guard extends Command {
  static description = 'Install/uninstall a git hook that runs validate-diff, or run it directly.';
  static examples = [
    '<%= config.bin %> guard install',
    '<%= config.bin %> guard install --hook pre-push --block',
    '<%= config.bin %> guard uninstall',
  ];
  static args = {
    action: Args.string({ description: 'install | uninstall | run', required: true, options: ['install', 'uninstall', 'run'] }),
  };
  static flags = {
    hook: Flags.string({ description: 'Hook to manage.', options: ['pre-commit', 'pre-push'], default: 'pre-commit' }),
    block: Flags.boolean({ description: 'Make the hook block (fail) on findings.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Guard);
    const msg = await runGuard(process.cwd(), args.action as GuardAction, {
      hook: flags.hook as HookName,
      block: flags.block,
    });
    this.log(msg);
  }
}
