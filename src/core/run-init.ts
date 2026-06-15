import fs from 'node:fs';
import path from 'node:path';
import { senseiDir, agentRulesPath, configPath } from '../paths.js';
import { writeDefaultConfig } from '../config/load.js';

const DEFAULT_AGENT_RULES = `# Agent Rules

- Reuse existing functions and modules listed in the context report before writing new ones.
- Do not modify files in the "do not touch" list without explicit confirmation.
- Match the existing code style, naming, and patterns of nearby files.
- Add or update tests for any behavior you change.
`;

export interface InitResult {
  created: string[];
}

export function runInit(cwd: string): InitResult {
  const created: string[] = [];
  fs.mkdirSync(senseiDir(cwd), { recursive: true });

  if (!fs.existsSync(configPath(cwd))) {
    writeDefaultConfig(cwd);
    created.push('.sensei/sensei.config.json');
  }
  if (!fs.existsSync(agentRulesPath(cwd))) {
    fs.writeFileSync(agentRulesPath(cwd), DEFAULT_AGENT_RULES);
    created.push('.sensei/agent-rules.md');
  }

  // Ensure the cache db is gitignored
  const gitignore = path.join(cwd, '.gitignore');
  const entry = '.sensei/cache.db';
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === entry)) {
    fs.writeFileSync(gitignore, (current && !current.endsWith('\n') ? current + '\n' : current) + entry + '\n');
    created.push('.gitignore (+.sensei/cache.db)');
  }
  return { created };
}
