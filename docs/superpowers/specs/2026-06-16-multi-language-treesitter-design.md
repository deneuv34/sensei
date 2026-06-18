# Multi-Language Support via Tree-sitter — Design

**Date:** 2026-06-16
**Status:** Approved (design); pending implementation plan
**Phase:** Roadmap — multi-language support
**Scope:** Add Python, Go, Rust, and Java to Sensei's symbol index for **reuse detection**, using Tree-sitter as a second parser backend alongside the existing `typescript` compiler path for TS/JS.

---

## 1. Goal & Non-Goals

### Goal
Extend Sensei beyond TypeScript/JavaScript so that `context`, `validate-diff`, and `validate-plan` surface **reuse candidates** for code written in Python, Go, Rust, and Java. The architecture must make adding a sixth language cheap: one `LangSpec` module + one query.

### Non-Goals (explicit, out of scope for this feature)
- **Import-graph / fan-in for the new languages.** Each language has a distinct module-resolution model (Python packages/`__init__.py`, Go `go.mod` package paths, Rust `mod`/`use`, Java package→dir). Resolving these is a separate, larger feature. New-language files contribute **no** imports, so fan-in is unaffected.
- **Migrating TS/JS off the `typescript` compiler** onto Tree-sitter. The shipped TS path stays as-is; uniform Tree-sitter is a possible *later* refactor.
- **Per-language `dangerous` entrypoint heuristics** beyond the existing path-glob (`dangerous.paths`) matching, which is language-independent and already works.

### Headline outcome
Sensei answers "what already exists here that I should reuse?" for five languages. It continues to answer "what's dangerous to touch?" with full fidelity only for TS/JS (fan-in); for the new languages, dangerous-target detection relies on `dangerous.paths` globs.

---

## 2. Key Decisions (from brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| Languages | Python, Go, Rust, Java | Broadest agent-codebase reach; validates the abstraction across four distinct module/symbol models. |
| Parser strategy | **Hybrid** — keep `typescript` compiler for TS/JS, Tree-sitter only for the four new langs | Don't destabilize the shipped, 101-test-green TS path; the TS compiler gives richer signatures/JSDoc than Tree-sitter yields cheaply. |
| Parity | **Reuse only** (symbols). Dangerous for new langs = `dangerous.paths` globs only | Reuse is the headline and the uniform/cheap part; four bespoke import resolvers multiply risk for the weaker half of the value. |
| Runtime | **WASM (`web-tree-sitter`)** + vendored `.wasm` grammars | No node-gyp, fully portable, deterministic, painless `npm i -g`. Async `init()` handled by pre-warming before the DB transaction. |
| Extraction style | **`.scm` query-driven**, one query + `LangSpec` per language | The whole point of the feature is cheap language addition. |

---

## 3. Architecture

### 3.1 Parser registry

`extractFromSource(filePath, source)` — the single extraction seam, called once in `indexer/index-repo.ts` — becomes a thin **dispatcher** that selects a backend by language:

- **TS backend**: today's `typescript`-compiler extractor, **moved verbatim** out of `ast/extract.ts` into `ast/extract-ts.ts`. Handles `ts` · `tsx` · `js` · `jsx`. Synchronous.
- **Tree-sitter backend**: a generic, `.scm`-query-driven extractor parameterized per language by a `LangSpec`. Handles `py` · `go` · `rust` · `java`. Synchronous *parse* (grammar pre-warmed).

The dispatcher keeps the existing public signature `extractFromSource(filePath: string, source: string): FileExtraction`, so `index-repo.ts` call sites are unchanged.

### 3.2 Module layout (new)

```
src/ast/
  extract.ts                       # dispatcher: lang → backend (public API unchanged)
  extract-ts.ts                    # current TS-compiler extractor, moved here unchanged
  treesitter/
    runtime.ts                     # web-tree-sitter loader: warmup(langs) async, getParser(lang) sync
    extract.ts                     # generic: parsed tree + LangSpec → ExtractedSymbol[]
    registry.ts                    # Lang → LangSpec map
    langs/
      python.ts                    # LangSpec (inline .scm query string + toSymbol)
      go.ts
      rust.ts
      java.ts
vendor/tree-sitter/
  tree-sitter.wasm                 # web-tree-sitter core runtime
  tree-sitter-python.wasm
  tree-sitter-go.wasm
  tree-sitter-rust.wasm
  tree-sitter-java.wasm
```

`.scm` queries are **inlined as TS string constants** inside each `langs/*.ts` (not separate files) so the `tsc`-only build needs no asset-copy step for queries. Only the binary `.wasm` grammars are vendored and shipped via `package.json` `files`.

### 3.3 `LangSpec` — the extension point

Adding a language = one new `langs/<lang>.ts` + register it. No core changes.

```ts
interface LangSpec {
  lang: Lang;                 // 'py' | 'go' | 'rust' | 'java' | (future)
  wasmFile: string;           // grammar filename under vendor/tree-sitter/
  query: string;              // inline .scm capture query
  /** Map one query match to a symbol, or null to skip. Builds kind, qualified
   *  name (e.g. Class.method), signature, exported flag, and doc text. */
  toSymbol(match: QueryMatch, source: string): ExtractedSymbol | null;
}
```

### 3.4 Runtime (`treesitter/runtime.ts`)

`web-tree-sitter` requires an async `Parser.init()` and async `Language.load(wasm)`. Parsing itself is synchronous once a grammar is loaded.

- `warmup(langs: Lang[]): Promise<void>` — idempotent; initializes the core runtime once and loads+caches each requested grammar's `Language`.
- `getParser(lang: Lang): Parser` — synchronous; returns a parser with the cached grammar set. Throws if not warmed (caller guarantees warmup first).
- Grammar `.wasm` paths resolved relative to the package root via `import.meta.url` (works from `dist/`).

This dissolves the async-vs-sync-transaction constraint: warm up **before** entering `better-sqlite3`'s synchronous transaction, then parse synchronously inside it.

---

## 4. Data Flow

### 4.1 `scanner/scan.ts`
- `extLang()` extended: `.py → 'py'`, `.go → 'go'`, `.rs → 'rust'`, `.java → 'java'`.
- `Lang` union (in `types.ts`) extended: `'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'rust' | 'java'`.

### 4.2 `indexer/index-repo.ts`
1. **Before** the transaction: collect the distinct non-TS langs among files that will be (re)parsed → `await runtime.warmup(langs)`. This is the only async step; skipped entirely when no new-lang files are present (TS-only repos pay nothing).
2. **Inside** the (synchronous) transaction: `extractFromSource(path, source)` dispatches. TS path synchronous as today; Tree-sitter path parses synchronously against the pre-warmed grammar.
3. New-language extractions return `imports: []` (reuse-only parity). `resolveModule` and `recomputeImporterCounts` are untouched, so fan-in for TS/JS is unchanged and new-lang files never affect importer counts.

### 4.3 Invariants
- **TS/JS extraction is byte-identical** (code moved, not modified) → all 101 existing tests stay green.
- **DB schema unchanged** — `files.lang TEXT` and the generic `symbols` table already accommodate any language; FTS5 (`symbols_fts`) indexes name/signature/jsdoc/path regardless of language.

---

## 5. Symbol Extraction Semantics

### 5.1 Kind mapping — reuse existing `SYMBOL_KINDS` (no type churn)

`SYMBOL_KINDS = ['function','class','method','interface','type','const','enum']` is left **unchanged**, so the FTS index, scorer, and similarity logic need no edits. Each language maps onto these:

| lang | construct → kind |
|------|------------------|
| **Python** | `def` (module) → function · `class` → class · `def` (in class) → method · module-level `ALL_CAPS =` → const |
| **Go** | `func` → function · `func` with receiver → method · `type … struct` → class · `type … interface` → interface · `const` → const · `type X = …` → type |
| **Rust** | `fn` (free) → function · `fn` in `impl` → method · `struct` → class · `trait` → interface · `enum` → enum · `type` alias → type · `const`/`static` → const |
| **Java** | `class` → class · `interface` → interface · `enum` → enum · method → method (no free functions) |

Method names are qualified as `Owner.method` (matching the existing TS extractor's `Class.method` convention).

### 5.2 `exported` flag — real per-language rules

| lang | exported when |
|------|---------------|
| **Go** | identifier starts uppercase (the actual language visibility rule) |
| **Rust** | `pub` (or `pub(...)`) present on the item |
| **Java** | `public` modifier present |
| **Python** | name does not start with `_` (convention) |

### 5.3 Signatures (quality-sensitive)

The scorer's duplicate similarity is ½ name-token-Jaccard + ½ signature-token-Jaccard, so signatures must be meaningful. `toSymbol` builds `name(params)[: ret]` from the parameter-list node text, mirroring the TS extractor:

| lang | example signature |
|------|-------------------|
| Python | `foo(a, b)` (append return annotation if present) |
| Go | `Foo(a int, b string) error` |
| Rust | `foo(a: u32) -> bool` |
| Java | `foo(int a)` (prepend/append return type) |

For non-callable kinds the signature mirrors TS conventions (`class Name`, `interface Name`, `type Name`, `enum Name`, or the bare name for `const`).

### 5.4 Doc comments → `jsdoc` field (best-effort, non-blocking)

Mapped into the existing `jsdoc` column (used by FTS and as scoring signal):

- Python: first string-literal statement in the body (docstring)
- Go: contiguous `//` comment block immediately preceding the declaration
- Rust: `///` / `//!` doc comments
- Java: `/** … */` Javadoc block

Empty string when absent. Never blocks extraction.

---

## 6. Error Handling

Extends the existing `warnings.push(...)` + skip pattern in `index-repo.ts`; **scan never crashes** on parser problems.

- **Per-file parse failure** → push warning, skip file. Tree-sitter produces partial trees for malformed input, so hard failures are rare.
- **Grammar `.wasm` missing or fails to load** → warn once for that language, skip its files. Other languages and the TS path continue.
- **`web-tree-sitter` core init failure** → warn once, degrade gracefully to TS-only indexing.

---

## 7. Configuration

- Default `include` (in `config/schema.ts`) extended to add `**/*.py`, `**/*.go`, `**/*.rs`, `**/*.java`.
- **Upgrade note:** existing repos with a written `sensei.config.json` keep their pinned `include` and must add the new globs to pick up the new languages. Fresh `sensei init` gets the broader default. Documented in README + CHANGELOG.
- No new config keys required for this feature.

---

## 8. Packaging

- Vendor the five `.wasm` files (core runtime + four grammars) under `vendor/tree-sitter/`.
- Add `vendor` to `package.json` `files` so the binaries ship to npm.
- Runtime resolves `.wasm` paths relative to the package root via `import.meta.url`; works from the published `dist/` layout.
- `.scm` queries are inline TS string constants → no asset-copy step needed for the `tsc`-only build.
- Add `web-tree-sitter` to `dependencies`. Grammar `.wasm` binaries are committed to the repo under `vendor/` (sourced from the published `tree-sitter-<lang>` builds), not pulled at install time, keeping installs deterministic and network-free.

---

## 9. Testing (TDD, red → green)

- **Per-language extractor unit tests** (one fixture per language): source snippet → expected `ExtractedSymbol[]` asserting name, kind, signature, `exported`, and `startLine`. Each fixture covers function + class + method + the language-specific kind (Go interface, Rust trait/enum, Java enum, Python class).
- **Registry dispatch test**: each extension routes to the correct backend.
- **Runtime warmup test**: each grammar loads and parses a trivial snippet; `getParser` before warmup throws.
- **Cross-language e2e**: build a small fixture repo containing a Python (and one other) symbol, `scan`, then assert `context` / `validate-diff` surfaces a **Python reuse candidate** end-to-end.
- **Regression**: the existing 101 tests remain unchanged and green (TS path moved, not modified).

---

## 10. Component Isolation Summary

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `ast/extract.ts` (dispatcher) | Route `(filePath, source)` to a backend by lang | `extract-ts`, `treesitter/extract`, `treesitter/registry` |
| `ast/extract-ts.ts` | TS/JS extraction (unchanged) | `typescript` |
| `treesitter/runtime.ts` | Load/cache grammars; provide parsers | `web-tree-sitter`, vendored `.wasm` |
| `treesitter/extract.ts` | Generic query → `ExtractedSymbol[]` | a `LangSpec` |
| `treesitter/registry.ts` | `Lang → LangSpec` lookup | `langs/*` |
| `treesitter/langs/<lang>.ts` | One language's query + `toSymbol` | `types` |

Each unit is independently testable; the dispatcher and registry isolate backend choice from the indexer, and each `LangSpec` is a self-contained, swappable language definition.
