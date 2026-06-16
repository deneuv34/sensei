// src/commands/scan.ts
import { Command, Flags } from '@oclif/core';
import { Listr } from 'listr2';
import { runScan } from '../core/run-scan.js';
import type { IndexResult } from '../indexer/index-repo.js';
import type { ScanPhase, ScanProgress } from '../core/progress.js';

const PHASE_ORDER: Record<ScanPhase, number> = { discover: 0, gitmeta: 1, parse: 2, resolve: 3 };

function renderProgress(p: ScanProgress): string {
  const count = p.total > 0 ? `${p.done}/${p.total}` : `${p.done}`;
  return p.detail ? `${count}  ${p.detail}` : count;
}

/**
 * Bridges the headless progress callback to listr2 tasks. A phase completes when
 * a later-phase event arrives (events are monotonic) or when the scan finishes.
 */
class ScanCoordinator {
  readonly promises = new Map<ScanPhase, Promise<void>>();
  private resolvers = new Map<ScanPhase, () => void>();
  private outputs = new Map<ScanPhase, (s: string) => void>();
  private latest = new Map<ScanPhase, ScanProgress>();

  constructor() {
    for (const phase of Object.keys(PHASE_ORDER) as ScanPhase[]) {
      this.promises.set(phase, new Promise<void>((res) => this.resolvers.set(phase, res)));
    }
  }

  bindOutput(phase: ScanPhase, set: (s: string) => void): void {
    this.outputs.set(phase, set);
    const last = this.latest.get(phase);
    if (last) set(renderProgress(last));
  }

  readonly handle = (p: ScanProgress): void => {
    this.latest.set(p.phase, p);
    this.outputs.get(p.phase)?.(renderProgress(p));
    // Any event completes all strictly-earlier phases.
    for (const [phase, n] of Object.entries(PHASE_ORDER) as [ScanPhase, number][]) {
      if (n < PHASE_ORDER[p.phase]) this.resolvers.get(phase)!();
    }
  };

  finishAll(): void {
    for (const resolve of this.resolvers.values()) resolve();
  }
}

export default class Scan extends Command {
  static description = 'Scan the repo and build the local symbol index.';

  static flags = {
    verbose: Flags.boolean({ description: 'List all warnings instead of a count.', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Scan);
    const cwd = process.cwd();
    const coord = new ScanCoordinator();

    const scanPromise: Promise<IndexResult> = runScan(cwd, coord.handle);
    // Release every phase gate on completion OR failure so no listr task can hang.
    void scanPromise.finally(() => coord.finishAll());
    // Close the unhandled-rejection window; the real error is surfaced via `await` below.
    scanPromise.catch(() => {});

    const phaseTask = (phase: ScanPhase) => async (_ctx: unknown, task: { output: string }) => {
      coord.bindOutput(phase, (s) => {
        task.output = s;
      });
      // Whichever settles first: the phase gate, or a scan failure (which fails the task
      // so listr's exitOnError aborts cleanly instead of "completing" with stale output).
      await Promise.race([coord.promises.get(phase)!, scanPromise.then(() => undefined)]);
    };

    const tasks = new Listr(
      [
        { title: 'Discover files', task: phaseTask('discover') },
        { title: 'Git history', task: phaseTask('gitmeta') },
        { title: 'Parse & index', task: phaseTask('parse') },
        { title: 'Resolve imports', task: phaseTask('resolve') },
      ],
      { concurrent: false, exitOnError: true, rendererOptions: { collapseSubtasks: false } },
    );

    await tasks.run();
    const result = await scanPromise;

    this.log('');
    this.log(
      `Scanned ${result.fileCount} files (${result.changed} changed), indexed ${result.symbolCount} symbols.`,
    );
    if (result.warnings.length) {
      if (flags.verbose) {
        this.log(`Warnings (${result.warnings.length}):`);
        for (const w of result.warnings) this.log(`  ! ${w}`);
      } else {
        this.log(`⚠ ${result.warnings.length} warnings (run with --verbose to see).`);
      }
    }
    this.log('Next: run `sensei context "<your task>"`.');
  }
}
