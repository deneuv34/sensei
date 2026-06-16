import path from 'node:path';

export const SENSEI_DIR = '.sensei';
export const senseiDir = (cwd: string) => path.join(cwd, SENSEI_DIR);
export const configPath = (cwd: string) => path.join(senseiDir(cwd), 'sensei.config.json');
export const dbPath = (cwd: string) => path.join(senseiDir(cwd), 'cache.db');
export const contextMdPath = (cwd: string) => path.join(senseiDir(cwd), 'current-task-context.md');
export const candidatesJsonPath = (cwd: string) => path.join(senseiDir(cwd), 'reuse-candidates.json');
export const agentRulesPath = (cwd: string) => path.join(senseiDir(cwd), 'agent-rules.md');
export const lastValidationJsonPath = (cwd: string) => path.join(senseiDir(cwd), 'last-validation.json');
