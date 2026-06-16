import { installHook, uninstallHook, type HookName } from '../guard/hook.js';
import { runValidateDiff } from './run-validate-diff.js';
import { renderValidation } from '../validate/report.js';

export type GuardAction = 'install' | 'uninstall' | 'run';

export interface GuardOptions {
  hook: HookName;
  block: boolean;
}

export async function runGuard(cwd: string, action: GuardAction, opts: GuardOptions): Promise<string> {
  if (action === 'install') {
    const file = await installHook(cwd, opts.hook, opts.block);
    return `Installed ${opts.hook} hook (${opts.block ? 'blocking' : 'warn-only'}): ${file}`;
  }
  if (action === 'uninstall') {
    const removed = await uninstallHook(cwd, opts.hook);
    return removed
      ? `Removed sensei block from ${opts.hook} hook.`
      : `No sensei block found in ${opts.hook} hook.`;
  }
  const report = await runValidateDiff(cwd, { mode: 'staged' }, { block: opts.block || undefined });
  return renderValidation(report);
}
