// src/core/progress.ts

/** Pipeline phase a progress event belongs to. */
export type ScanPhase = 'discover' | 'gitmeta' | 'parse' | 'resolve';

export interface ScanProgress {
  phase: ScanPhase;
  /** items processed so far within the phase */
  done: number;
  /** total items in the phase; 0 means indeterminate */
  total: number;
  /** current item, e.g. a file path */
  detail?: string;
}

export type ProgressFn = (progress: ScanProgress) => void;

/** Default reporter: discards events, keeping core headless. */
export const noopProgress: ProgressFn = () => {};
