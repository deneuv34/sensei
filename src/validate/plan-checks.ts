import type { IndexDb } from '../indexer/db.js';
import type { SenseiConfig } from '../config/schema.js';
import { tokenize } from '../text/tokenize.js';
import { searchSymbols } from '../search/search.js';
import { findDangerousFiles } from '../scorer/score.js';
import { nameContainment } from './similarity.js';
import { firstDangerousMatch } from './glob.js';
import type { Finding, FindingKind, Severity } from './report.js';
import type { ProposedTarget } from './plan-parse.js';

export interface PlanCheckContext {
  targets: ProposedTarget[];
  db: IndexDb;
  config: SenseiConfig;
  severity: Severity;
}

export interface PlanCheck {
  kind: FindingKind;
  enabled(config: SenseiConfig): boolean;
  run(ctx: PlanCheckContext): Finding[];
}

function baseNoExt(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.(?:ts|tsx|js|jsx)$/, '');
}

const reuseCandidateCheck: PlanCheck = {
  kind: 'reuse-candidate',
  enabled: (config) => config.validate.checkDuplicates,
  run({ targets, db, config, severity }) {
    const threshold = config.validate.duplicateThreshold;
    const proposedFiles = new Set(targets.filter((t) => t.kind === 'file').map((t) => t.value));
    const out: Finding[] = [];
    for (const t of targets) {
      if (t.action === 'modify') continue;
      if (tokenize(t.value).length === 0) continue;
      if (t.kind === 'symbol') {
        const best = searchSymbols(db, tokenize(t.value))
          .filter((h) => !proposedFiles.has(h.path))
          .map((h) => ({ path: h.path, line: h.start_line, name: h.name, score: nameContainment(t.value, h.name) }))
          .filter((r) => r.score >= threshold)
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.name.localeCompare(b.name))[0];
        if (best) {
          out.push({
            kind: 'reuse-candidate', severity, file: t.value, line: t.line,
            message: `plan proposes ${t.value}; existing ${best.name} at ${best.path}:${best.line} already covers this (match ${best.score.toFixed(2)}) — extend it instead of creating new.`,
            related: best,
          });
        }
      } else {
        const planBase = baseNoExt(t.value);
        const best = db.allFiles()
          .filter((f) => f.path !== t.value)
          .map((f) => ({ path: f.path, line: 1, name: baseNoExt(f.path), score: nameContainment(planBase, baseNoExt(f.path)) }))
          .filter((r) => r.score >= threshold)
          .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
        if (best) {
          out.push({
            kind: 'reuse-candidate', severity, file: t.value, line: t.line,
            message: `plan proposes new file ${t.value}; existing ${best.path} looks equivalent (match ${best.score.toFixed(2)}) — extend it instead.`,
            related: best,
          });
        }
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  },
};

const dangerousTargetCheck: PlanCheck = {
  kind: 'dangerous-target',
  enabled: (config) => config.validate.checkDangerous,
  run({ targets, db, config, severity }) {
    const danger = new Map(findDangerousFiles(db, config).map((d) => [d.path, d]));
    const globs = config.dangerous.paths;
    const out: Finding[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      if (t.kind !== 'file' || seen.has(t.value)) continue;
      const glob = firstDangerousMatch(t.value, globs);
      if (glob) {
        seen.add(t.value);
        out.push({ kind: 'dangerous-target', severity, file: t.value, line: t.line, message: `plan targets ${t.value} — matches dangerous path \`${glob}\`; do not modify casually.` });
        continue;
      }
      const d = danger.get(t.value);
      if (d) {
        seen.add(t.value);
        out.push({ kind: 'dangerous-target', severity, file: t.value, line: t.line, message: `plan targets ${t.value} — ${d.reason} (importer_count ${d.importerCount}); do not modify casually.` });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  },
};

export const PLAN_CHECKS: PlanCheck[] = [reuseCandidateCheck, dangerousTargetCheck];

export function runPlanChecks(ctx: PlanCheckContext): Finding[] {
  return PLAN_CHECKS.filter((c) => c.enabled(ctx.config)).flatMap((c) => c.run(ctx));
}
