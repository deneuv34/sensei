import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import type { Lang } from '../../types.js';

const WASM_BY_LANG: Partial<Record<Lang, string>> = {
  py: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
};

// runtime.js lives at dist/ast/treesitter/runtime.js; vendor/ is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.resolve(here, '../../../vendor/tree-sitter');

let initPromise: Promise<void> | null = null;
const languages = new Map<Lang, Language>();
const parsers = new Map<Lang, Parser>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

/** Load and cache grammars for the given languages. Returns non-fatal warnings. */
export async function warmup(langs: Lang[]): Promise<string[]> {
  const wanted = [...new Set(langs)].filter((l) => l in WASM_BY_LANG);
  if (wanted.length === 0) return [];

  try {
    await ensureInit();
  } catch (err) {
    return [`tree-sitter init failed: ${(err as Error).message}`];
  }

  const warnings: string[] = [];
  for (const lang of wanted) {
    if (parsers.has(lang)) continue;
    const wasm = path.join(vendorDir, WASM_BY_LANG[lang]!);
    try {
      const language = await Language.load(wasm);
      const parser = new Parser();
      parser.setLanguage(language);
      languages.set(lang, language);
      parsers.set(lang, parser);
    } catch (err) {
      warnings.push(`could not load ${lang} grammar: ${(err as Error).message}`);
    }
  }
  return warnings;
}

export function getParser(lang: Lang): Parser | undefined {
  return parsers.get(lang);
}

export function getLanguage(lang: Lang): Language | undefined {
  return languages.get(lang);
}
