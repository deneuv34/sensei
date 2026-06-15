export const SYMBOL_KINDS = ['function', 'class', 'method', 'interface', 'type', 'const', 'enum'] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];
export type Lang = 'ts' | 'tsx' | 'js' | 'jsx';

export interface ScannedFile {
  path: string;                 // repo-relative, posix-separated
  hash: string;                 // sha1 of file contents
  lang: Lang;
  loc: number;                  // line count
  gitLastModified: number | null; // unix seconds, null if not in git
  gitCommitCount: number;
}

export interface ExtractedSymbol {
  kind: SymbolKind;
  name: string;
  signature: string;
  exported: boolean;
  startLine: number;
  jsdoc: string;
}

export interface ExtractedImport {
  module: string;               // module specifier text
  importedName: string;         // named import, or 'default' / '*'
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

export interface ReuseCandidate {
  path: string;
  line: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  score: number;                // 0..1
  reasons: string[];
}

export interface DangerousFile {
  path: string;
  importerCount: number;
  reason: string;
}

export interface ContextReport {
  task: string;
  generatedAt: string;          // ISO string
  reuseCandidates: ReuseCandidate[];
  dangerousFiles: DangerousFile[];
  agentRules: string[];
}
