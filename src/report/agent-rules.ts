import fs from 'node:fs';
import { agentRulesPath } from '../paths.js';

export function readAgentRules(cwd: string): string[] {
  const file = agentRulesPath(cwd);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim())
    .filter((l): l is string => Boolean(l));
}
