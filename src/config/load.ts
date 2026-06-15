import fs from 'node:fs';
import { ConfigSchema, DEFAULT_CONFIG, type SenseiConfig } from './schema.js';
import { configPath, senseiDir } from '../paths.js';

export function loadConfig(cwd: string): SenseiConfig {
  const file = configPath(cwd);
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid sensei.config.json: not valid JSON (${(err as Error).message})`);
    }
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid sensei.config.json: ${result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

export function writeDefaultConfig(cwd: string): void {
  fs.mkdirSync(senseiDir(cwd), { recursive: true });
  fs.writeFileSync(configPath(cwd), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
}
