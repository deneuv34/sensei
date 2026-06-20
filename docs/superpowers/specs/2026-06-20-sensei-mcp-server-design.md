# Sensei MCP Server (`sensei mcp`) — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan
**Phase:** Roadmap — dynamic, per-task retrieval (the live counterpart to the static `export --write` files)

## Summary

Add a `sensei mcp` command that runs a **Model Context Protocol server over stdio**, exposing Sensei's reuse-detection to any MCP client (Claude Code, Cursor, Codex). Today an agent only gets Sensei's context when a human runs `sensei context "<task>"` by hand, or from a static rule file written once by `export --write`. The MCP server lets the **agent itself** pull fresh, task-specific reuse candidates mid-session, exactly when it is about to write code — one integration that every MCP-speaking client can use.

The server reuses existing core (`runScan`, `runContext`, `renderCodex`); it adds no new retrieval logic.

---

## 1. Goals & Non-Goals

### Goals
- `sensei mcp` starts a stdio MCP server scoped to the launch directory (the repo).
- Expose a `find_reuse(task)` tool that returns the reuse/danger report as markdown, over a **fresh** index.
- Expose a `scan()` tool to rebuild the index on demand.
- Work with zero per-project code: the client spawns the binary with `cwd` = repo root.

### Non-Goals (deferred, YAGNI)
- **No HTTP/SSE transport.** stdio only; the index is local on local disk. HTTP is trivial to add later via the SDK if a remote/shared use case appears.
- **No `structuredContent` / JSON output.** An LLM consumes markdown better than JSON; the existing renderer already frames reuse + danger + rules. Add `structuredContent` only when a non-LLM client needs it.
- **No `validate_diff` / `validate_plan` tools.** Those belong to the commit/PR gate, not the live-prompt loop. Add later if the agent loop wants self-check.
- **No `--cwd` override.** Use `process.cwd()`; the client sets the working directory.

---

## 2. Key Decisions (from brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| Tool surface | `find_reuse` + `scan` (option B) | `find_reuse` is the goal; `scan` pairs with it because a stale index is the #1 failure mode. Validate tools are a separate concern. |
| Staleness | `find_reuse` runs an incremental scan first, then queries (option C) | `runScan` is already cheap-when-clean (walk+hash, re-parse only changed files), so "scan-if-needed" needs no separate dirty-check — calling incremental scan **is** the freshness check. |
| Transport | stdio only (option A) | Local repo, local index. Native fit for client-spawned dev-tool servers; no ports, no auth. |
| Output | markdown via existing `renderCodex` (option A) | LLM-friendly; one renderer already exists and is tested. No second output format to maintain. |
| Query side-effect | `find_reuse` does **not** write `.sensei/` report files | A read tool should not clobber the CLI's last-context files on every agent call. New `write:false` path on `runContext`. |

---

## 3. Architecture

```
MCP client (Claude Code / Cursor / Codex)
   │  spawns:  sensei mcp     (cwd = repo root)
   ▼
src/commands/mcp.ts   ── oclif command
   │  • creates McpServer + StdioServerTransport
   │  • connects, stays alive
   │  • logs ONLY to stderr (stdout is the JSON-RPC wire)
   ▼
src/mcp/server.ts     ── buildServer(cwd): McpServer
   │  registers two tools:
   ├── find_reuse({ task }) → runScan(cwd) → runContext(cwd, task, {write:false}) → renderCodex → text
   └── scan({})            → runScan(cwd) → summary text
   ▼
existing core: runScan / runContext / renderCodex  (unchanged behavior)
```

### Tools

**`find_reuse`**
- **Description** (the agent's trigger signal): *"Search the indexed codebase for existing functions, classes, and symbols to reuse before writing new code for a task, plus high-impact files to avoid editing. Call this before implementing any feature or change."*
- **Input:** `{ task: string }` — natural-language description of what is about to be built.
- **Handler:**
  1. `const scan = await runScan(cwd)` — incremental; returns `{ fileCount, symbolCount, changed, warnings }`.
  2. `const report = await runContext(cwd, task, { write: false })`.
  3. `const body = renderCodex(report)`.
  4. Prepend a freshness line: `> index: ${scan.fileCount} files · ${scan.changed} changed · ${scan.symbolCount} symbols` (and `· ${scan.warnings.length} warnings` when non-zero).
  5. Return `{ content: [{ type: 'text', text: freshness + '\n\n' + body }] }`.

**`scan`**
- **Description:** *"Rebuild Sensei's local code index (incremental). Call after large external code changes if find_reuse results look stale."*
- **Input:** `{}` (no args).
- **Handler:** `const r = await runScan(cwd)` → return text `Scanned ${r.fileCount} files, ${r.symbolCount} symbols (${r.changed} changed${warnings})`.

### Server identity
`new McpServer({ name: 'sensei', version: <package.json version> })`.

---

## 4. SDK API (target: `@modelcontextprotocol/sdk` 1.x stable)

- `McpServer` — `@modelcontextprotocol/sdk/server/mcp.js`
- `StdioServerTransport` — `@modelcontextprotocol/sdk/server/stdio.js`
- `InMemoryTransport` (`.createLinkedPair()`) — `@modelcontextprotocol/sdk/inMemory.js` (tests)
- `Client` — `@modelcontextprotocol/sdk/client/index.js` (tests)
- Registration: `server.registerTool(name, { title, description, inputSchema }, handler)`, where `inputSchema` is a zod raw shape (e.g. `{ task: z.string() }`) — the project already depends on `zod`. Handler returns `{ content: [{ type: 'text', text }] }`; on failure return `{ content: [...], isError: true }`.

> Pin a current `1.x` at implementation time and verify the exact subpath exports against the installed version before finalizing imports.

---

## 5. File-by-file

| File | Change |
|------|--------|
| `src/mcp/server.ts` | **new** — `buildServer(cwd: string): McpServer`. Registers `find_reuse` + `scan`, wires handlers to existing core, wraps handler bodies in try/catch → `isError` content. No transport here (testable in isolation). |
| `src/commands/mcp.ts` | **new** — oclif `Mcp` command. `buildServer(process.cwd())`, `new StdioServerTransport()`, `await server.connect(transport)`. All status/error logging via `process.stderr` / `console.error` — never `this.log`. Process stays alive on the transport. |
| `src/core/run-context.ts` | **modify** — signature `runContext(cwd, task, opts?: { now?: Date; write?: boolean })`; `write` defaults `true`. Only call `writeReport` when `write !== false`. Behavior for existing callers unchanged. |
| `src/commands/context.ts` | **modify** — adapt to the opts signature (still writes; default). |
| `test/e2e.test.ts` | **modify** — update the `runContext(work, task, new Date(...))` call to the opts signature. |
| `package.json` | **modify** — add `@modelcontextprotocol/sdk` (1.x); add the `mcp` command to oclif's command discovery (already globbed from `dist/commands`). |
| `test/mcp.test.ts` | **new** — see §7. |

---

## 6. Error handling & concurrency

- **stdout is the protocol.** The `mcp` command must never write to stdout (no `this.log`, no `console.log`). Human-facing output goes to **stderr**. A stray stdout byte corrupts the JSON-RPC stream. (Hard constraint.)
- **No index yet:** `find_reuse` calls `runScan` first, which migrates/creates the DB — so the "No index found" path in `runContext` cannot trigger via the server. First call simply pays a full scan.
- **Scan parse warnings:** `runScan` collects warnings and does not throw; the freshness line surfaces the count and the query proceeds.
- **Handler exceptions:** each tool handler is wrapped in try/catch and returns `{ isError: true, content: [{ type:'text', text: message }] }` — the server stays up.
- **Concurrency:** single Node thread + synchronous `better-sqlite3` + sequential MCP request handling ⇒ no DB races. `runScan` and `runContext` each open and close their own `IndexDb`.

---

## 7. Testing

**`test/mcp.test.ts`** — integration via in-process transport, no subprocess:
1. Seed a temp repo (a couple of source files with a known symbol, e.g. `login`), `runScan` it.
2. `InMemoryTransport.createLinkedPair()`; connect a `Client` to `buildServer(tmp)`.
3. `client.callTool({ name: 'find_reuse', arguments: { task: 'add login with password' } })` → assert the text content contains the freshness line and the known candidate (`login`) under the reuse heading.
4. `client.callTool({ name: 'scan', arguments: {} })` → assert summary text (`Scanned N files`).
5. Edge: `find_reuse` on an empty repo (no candidates) returns the empty-state markdown without throwing.

**`run-context` unit test** — `runContext(cwd, task, { write: false })` returns a report **and writes no `.sensei/reuse-candidates.json` / `current-task-context.md`** (assert the files are absent / unchanged); default (`write` omitted) still writes.

All tests deterministic, no network (the SDK in-memory transport is local), no API key.

---

## 8. Release

Own PR, own minor release (`0.9.0`). Adds one runtime dependency (`@modelcontextprotocol/sdk`). After merge, document the client config snippet (spawn `sensei mcp`, cwd = repo) in the README.
