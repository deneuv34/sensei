import type { IndexDb, SymbolHitRow, FileRow } from '../indexer/db.js';
import type { ReuseCandidate, DangerousFile, SymbolKind } from '../types.js';
import type { SenseiConfig } from '../config/schema.js';
import { tokenize } from '../text/tokenize.js';

/** Stems (basename without extension/test-suffix) that have an associated test file. */
function testedStems(files: FileRow[]): Set<string> {
  const stems = new Set<string>();
  for (const f of files) {
    const m = f.path.match(/([^/]+)\.(test|spec)\.(ts|tsx|js|jsx)$/);
    if (m) stems.add(m[1]);
  }
  return stems;
}

function baseStem(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.(ts|tsx|js|jsx)$/, '');
}

export function scoreCandidates(
  hits: SymbolHitRow[],
  queryTokens: string[],
  config: SenseiConfig,
  db: IndexDb,
): ReuseCandidate[] {
  const w = config.scoring;
  const { min, max } = db.mtimeStats();
  const tested = testedStems(db.allFiles());

  const candidates: ReuseCandidate[] = hits.map((hit) => {
    const reasons: string[] = [];
    let score = 0;

    const nameTokens = tokenize(`${hit.name} ${hit.signature}`);
    const overlap = queryTokens.filter((t) => nameTokens.includes(t)).length;
    if (overlap > 0 && queryTokens.length > 0) {
      const nameScore = overlap / queryTokens.length;
      score += w.nameOverlap * nameScore;
      reasons.push(`name/signature matches ${overlap} task term(s)`);
    }

    const pathTokens = tokenize(hit.path);
    if (queryTokens.some((t) => pathTokens.includes(t))) {
      score += w.pathMatch;
      reasons.push('file path matches task domain');
    }

    if (hit.exported === 1) {
      score += w.exportedBoost;
      reasons.push('exported (public API)');
    }

    if (hit.git_last_modified != null && min != null && max != null && max > min) {
      const recency = (hit.git_last_modified - min) / (max - min);
      if (recency > 0) {
        score += w.gitRecency * recency;
        reasons.push('recently modified');
      }
    }

    if (tested.has(baseStem(hit.path))) {
      score += w.testExists;
      reasons.push('has tests nearby');
    }

    return {
      path: hit.path,
      line: hit.start_line,
      name: hit.name,
      kind: hit.kind as SymbolKind,
      signature: hit.signature,
      score: Math.max(0, Math.min(1, score)),
      reasons,
    };
  });

  // Deterministic ordering: score desc, then path asc, then name asc
  candidates.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  );
  return candidates;
}

function isEntrypoint(p: string): boolean {
  return /(^|\/)(index|main)\.(ts|tsx|js|jsx)$/.test(p);
}

export function findDangerousFiles(db: IndexDb, config: SenseiConfig): DangerousFile[] {
  const out: DangerousFile[] = [];
  for (const f of db.allFiles()) {
    if (f.importer_count >= config.dangerous.importerThreshold) {
      out.push({ path: f.path, importerCount: f.importer_count, reason: `${f.importer_count} files import this` });
    } else if (isEntrypoint(f.path)) {
      out.push({ path: f.path, importerCount: f.importer_count, reason: 'entrypoint file' });
    }
  }
  out.sort((a, b) => b.importerCount - a.importerCount || a.path.localeCompare(b.path));
  return out;
}
