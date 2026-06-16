import { tokenize } from '../text/tokenize.js';

/** Symmetric token-Jaccard of two token lists. */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

/** 50/50 name+signature similarity. Used where the signature is known (diff). */
export function symbolSimilarity(
  a: { name: string; signature: string },
  b: { name: string; signature: string },
): number {
  const nameSim = jaccard(tokenize(a.name), tokenize(b.name));
  const sigSim = jaccard(tokenize(a.signature), tokenize(b.signature));
  return 0.5 * nameSim + 0.5 * sigSim;
}

/**
 * Fraction of an existing symbol's meaningful tokens echoed by a proposed name.
 * Used by validate-plan, where a proposal has a name but no signature yet.
 * Single-token existing names only match an exact single-token proposal,
 * suppressing common short names (validate, index, handler).
 */
export function nameContainment(proposedName: string, existingName: string): number {
  const proposed = new Set(tokenize(proposedName));
  const existing = tokenize(existingName);
  if (proposed.size === 0 || existing.length === 0) return 0;
  let inter = 0;
  for (const t of existing) if (proposed.has(t)) inter += 1;
  if (existing.length === 1) return inter === 1 && proposed.size === 1 ? 1 : 0;
  return inter / existing.length;
}
