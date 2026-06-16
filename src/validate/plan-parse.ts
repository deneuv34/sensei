import { tokenize } from '../text/tokenize.js';

export interface ProposedTarget {
  kind: 'file' | 'symbol';
  value: string;                       // posix path (file) or symbol name (symbol)
  action: 'create' | 'modify' | 'unknown';
  line: number;                        // 1-based line in the plan
  confidence: 'high' | 'low';          // high = structured section, low = heuristic
}

const CREATE_VERBS = ['create', 'add', 'new', 'introduce', 'scaffold', 'generate', 'implement'];
const MODIFY_VERBS = ['modify', 'change', 'edit', 'update', 'extend', 'reuse', 'refactor'];

const HEADER = /^#{1,6}\s+/;
const FILE_HEADER = /^#{1,6}\s+(.*\bfiles?\b.*)$/i;
const SYMBOL_HEADER = /^#{1,6}\s+(.*\b(?:symbols?|functions?|classes|methods?)\b.*)$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;

const FILE_PATH = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx)\b/g;
const BACKTICK_SYMBOL = /`([A-Za-z_$][\w$.]*?)\(?\)?`/g;
const PASCAL = /\b[A-Z][A-Za-z0-9]{2,}\b/g;
const CALL = /\b([a-z_$][\w$]*)\(/g;

function hasWord(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

function inferAction(text: string): ProposedTarget['action'] {
  if (hasWord(text, MODIFY_VERBS)) return 'modify';
  if (hasWord(text, CREATE_VERBS)) return 'create';
  return 'unknown';
}

function firstFilePath(text: string): string | null {
  const m = text.match(FILE_PATH);
  return m ? m[0] : null;
}

function cleanSymbol(raw: string): string {
  return raw.replace(/\(\)$/, '');
}

function firstSymbol(text: string): string | null {
  const bt = text.match(/`([A-Za-z_$][\w$.]*?)\(?\)?`/);
  if (bt) {
    const s = cleanSymbol(bt[1]);
    if (tokenize(s).length > 0) return s;
  }
  const pascal = text.match(/\b[A-Z][A-Za-z0-9]{2,}\b/);
  if (pascal && tokenize(pascal[0]).length > 0) return pascal[0];
  const call = text.match(/\b([a-z_$][\w$]*)\(/);
  if (call && tokenize(call[1]).length > 0) return call[1];
  return null;
}

function heuristicSymbols(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(BACKTICK_SYMBOL)) {
    const s = cleanSymbol(m[1]);
    if (tokenize(s).length > 0) found.add(s);
  }
  for (const m of text.matchAll(PASCAL)) {
    // Bare PascalCase in prose is noisy; require a compound (>= 2 meaningful tokens)
    // so common single words (System, Update) are dropped but RefundManager is kept.
    if (tokenize(m[0]).length >= 2) found.add(m[0]);
  }
  for (const m of text.matchAll(CALL)) {
    if (tokenize(m[1]).length > 0) found.add(m[1]);
  }
  return [...found];
}

function structuredTargets(lines: string[]): ProposedTarget[] {
  const out: ProposedTarget[] = [];
  let mode: 'file' | 'symbol' | null = null;
  let action: ProposedTarget['action'] = 'unknown';
  lines.forEach((raw, i) => {
    if (HEADER.test(raw)) {
      const fileM = raw.match(FILE_HEADER);
      const symM = raw.match(SYMBOL_HEADER);
      if (fileM) { mode = 'file'; action = inferAction(fileM[1]); }
      else if (symM) { mode = 'symbol'; action = inferAction(symM[1]); }
      else { mode = null; }
      return;
    }
    if (mode === null) return;
    const item = raw.match(LIST_ITEM);
    if (!item) return;
    if (mode === 'file') {
      const file = firstFilePath(item[1]);
      if (file) out.push({ kind: 'file', value: file, action, line: i + 1, confidence: 'high' });
    } else {
      const sym = firstSymbol(item[1]);
      if (sym) out.push({ kind: 'symbol', value: sym, action, line: i + 1, confidence: 'high' });
    }
  });
  return out;
}

function heuristicTargets(lines: string[]): ProposedTarget[] {
  const out: ProposedTarget[] = [];
  lines.forEach((raw, i) => {
    if (HEADER.test(raw)) return; // headers are owned by the structured pass
    const action = inferAction(raw);
    for (const m of raw.matchAll(FILE_PATH)) {
      out.push({ kind: 'file', value: m[0], action, line: i + 1, confidence: 'low' });
    }
    for (const sym of heuristicSymbols(raw)) {
      out.push({ kind: 'symbol', value: sym, action, line: i + 1, confidence: 'low' });
    }
  });
  return out;
}

export function parsePlan(text: string): ProposedTarget[] {
  const lines = text.split(/\r?\n/);
  const byKey = new Map<string, ProposedTarget>();
  // structured first so high-confidence entries win dedup
  for (const t of [...structuredTargets(lines), ...heuristicTargets(lines)]) {
    const key = `${t.kind}:${t.value}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, t); continue; }
    if (existing.confidence === 'low' && t.confidence === 'high') byKey.set(key, t);
  }
  return [...byKey.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
  );
}
