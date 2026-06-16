// test/progress.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { runScan } from '../src/core/run-scan.js';
import type { ScanPhase, ScanProgress } from '../src/core/progress.js';

const sampleRepo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('runScan progress', () => {
  it('reports phases in order with non-decreasing done within a phase', async () => {
    // copy fixture to a temp dir so the .sensei db is not written into the repo
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-progress-'));
    fs.cpSync(sampleRepo, tmp, { recursive: true });

    const events: ScanProgress[] = [];
    await runScan(tmp, (p) => events.push(p));

    expect(events.length).toBeGreaterThan(0);

    // Phase order: each phase's first appearance must follow the canonical order.
    const order: Record<ScanPhase, number> = { discover: 0, gitmeta: 1, parse: 2, resolve: 3 };
    const firstSeen: Partial<Record<ScanPhase, number>> = {};
    events.forEach((e, i) => {
      if (firstSeen[e.phase] === undefined) firstSeen[e.phase] = i;
    });
    const seenPhases = Object.keys(firstSeen) as ScanPhase[];
    const byFirstSeen = [...seenPhases].sort((a, b) => firstSeen[a]! - firstSeen[b]!);
    const byCanonical = [...seenPhases].sort((a, b) => order[a] - order[b]);
    expect(byFirstSeen).toEqual(byCanonical);

    // discover ticks are monotonically non-decreasing in `done`
    const discoverDone = events.filter((e) => e.phase === 'discover').map((e) => e.done);
    for (let i = 1; i < discoverDone.length; i++) {
      expect(discoverDone[i]).toBeGreaterThanOrEqual(discoverDone[i - 1]);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
