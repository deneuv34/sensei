import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from '../src/config/load.js';
import { DEFAULT_CONFIG, ConfigSchema } from '../src/config/schema.js';
import { configPath } from '../src/paths.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-cfg-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('config', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(dir);
    expect(cfg.version).toBe(1);
    expect(cfg.context.topN).toBe(10);
    expect(cfg.scoring.nameOverlap).toBe(0.4);
  });

  it('writes a default config file that round-trips', () => {
    writeDefaultConfig(dir);
    expect(fs.existsSync(configPath(dir))).toBe(true);
    const cfg = loadConfig(dir);
    expect(cfg.dangerous.importerThreshold).toBe(5);
  });

  it('merges partial user config over defaults', () => {
    fs.mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    fs.writeFileSync(configPath(dir), JSON.stringify({ context: { topN: 3 } }));
    const cfg = loadConfig(dir);
    expect(cfg.context.topN).toBe(3);
    expect(cfg.scoring.pathMatch).toBe(0.2); // untouched default
  });

  it('throws a clear error on malformed config', () => {
    fs.mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    fs.writeFileSync(configPath(dir), JSON.stringify({ context: { topN: -1 } }));
    expect(() => loadConfig(dir)).toThrow(/Invalid sensei.config.json/);
  });
});

describe('validate config block', () => {
  it('defaults to warn-only with a 0.7 duplicate threshold and both checks on', () => {
    expect(DEFAULT_CONFIG.validate).toEqual({
      block: false,
      duplicateThreshold: 0.7,
      checkDuplicates: true,
      checkDangerous: true,
    });
  });

  it('accepts overrides', () => {
    const cfg = ConfigSchema.parse({ validate: { block: true, duplicateThreshold: 0.9 } });
    expect(cfg.validate.block).toBe(true);
    expect(cfg.validate.duplicateThreshold).toBe(0.9);
    expect(cfg.validate.checkDuplicates).toBe(true); // unspecified keys keep defaults
  });
});
