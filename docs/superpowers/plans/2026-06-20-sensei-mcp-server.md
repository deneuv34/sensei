# Sensei MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sensei mcp` command that runs a stdio MCP server exposing two tools — `find_reuse(task)` and `scan()` — so any MCP client (Claude Code, Cursor, Codex) can pull fresh reuse/danger context mid-session.

**Architecture:** A thin oclif command (`src/commands/mcp.ts`) wires an `McpServer` (built in `src/mcp/server.ts`) to a `StdioServerTransport`. The server's two tool handlers reuse existing core — `runScan`, `runContext`, `renderCodex` — adding no retrieval logic. `find_reuse` runs an incremental scan first (which is cheap when clean), then renders the report as markdown. A new `write:false` option on `runContext` keeps the query side-effect-free.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `@modelcontextprotocol/sdk` (new), `zod` (already present), oclif commands, `better-sqlite3` (already present), vitest.

## Global Constraints

- Node `>=22`, ESM (`"type": "module"`); all relative imports use `.js` extensions.
- **One new dependency only:** `@modelcontextprotocol/sdk` (`^1`). No others.
- **stdout is the JSON-RPC wire in the `mcp` command** — never `this.log`/`console.log` there. All human-facing output goes to **stderr** (`process.stderr.write` / `console.error`).
- `runContext`'s existing behavior must not change for current callers: `write` defaults to `true`; the CLI `context` command still writes its report files.
- `renderCodex`, `renderClaude`, and `runScan` behavior unchanged.
- Tool names exact: `find_reuse`, `scan`. Server identity: `{ name: 'sensei', version: <oclif this.config.version> }`.
- Tests: `vitest`, in-memory transport (no subprocess, no network), deterministic, no API key. Run with `npx vitest run <file>`.
- Conventional Commits for messages.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/run-context.ts` | **modify** — add `opts?: { now?; write? }`; skip `writeReport` when `write === false`. |
| `src/commands/context.ts` | **modify** — no signature change needed (uses defaults); leave as-is unless typecheck requires. |
| `test/e2e.test.ts` | **modify** — migrate two positional-`now` calls to the opts object. |
| `test/run-context.test.ts` | **new** — unit test for the `write:false` side-effect contract. |
| `src/mcp/server.ts` | **new** — `buildServer(cwd, version): McpServer`; registers `find_reuse` + `scan`. |
| `test/mcp.test.ts` | **new** — in-memory client↔server integration. |
| `src/commands/mcp.ts` | **new** — oclif command; stdio transport; stderr-only logging. |
| `package.json` | **modify** — add `@modelcontextprotocol/sdk`. |
| `README.md` | **modify** — add a short "MCP server" usage section. |

Sequencing: Task 1 (write-free `runContext`) → Task 2 (server + dep, depends on Task 1) → Task 3 (command + docs, depends on Task 2).

---

## Task 1: `runContext` write-free option

**Files:**
- Modify: `src/core/run-context.ts`
- Modify: `test/e2e.test.ts` (two call sites)
- Test: `test/run-context.test.ts` (new)

**Interfaces:**
- Produces: `runContext(cwd: string, task: string, opts?: { now?: Date; write?: boolean }): Promise<ContextReport>`. `now` defaults to `new Date()`; `write` defaults to `true`. When `write === false`, no `.sensei/reuse-candidates.json` or `.sensei/current-task-context.md` is written; the returned report is identical.

- [ ] **Step 1: Write the failing test**

Create `test/run-context.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../src/core/run-init.js';
import { runScan } from '../src/core/run-scan.js';
import { runContext } from '../src/core/run-context.js';
import { candidatesJsonPath, contextMdPath } from '../src/paths.js';

let dir: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-ctx-'));
  runInit(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'login.ts'),
    'export function login(email: string, password: string): boolean {\n  return Boolean(email && password);\n}\n',
  );
  await runScan(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runContext write option', () => {
  it('writes no report files when write is false', async () => {
    const report = await runContext(dir, 'add login', { write: false });
    expect(report.task).toBe('add login');
    expect(fs.existsSync(candidatesJsonPath(dir))).toBe(false);
    expect(fs.existsSync(contextMdPath(dir))).toBe(false);
  });

  it('writes report files by default', async () => {
    await runContext(dir, 'add login');
    expect(fs.existsSync(candidatesJsonPath(dir))).toBe(true);
    expect(fs.existsSync(contextMdPath(dir))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/run-context.test.ts`
Expected: FAIL — `write:false` still writes (file exists), and/or TS error: object arg not assignable to `now: Date`.

- [ ] **Step 3: Update `runContext` to the opts signature**

In `src/core/run-context.ts`, replace the function signature and the `writeReport` call. The current body is:

```typescript
export async function runContext(cwd: string, task: string, now: Date = new Date()): Promise<ContextReport> {
```
...
```typescript
    const report = buildReport(task, ranked, dangerous, rules, now);
    writeReport(cwd, report);
    return report;
```

Change to:

```typescript
export interface ContextOptions {
  now?: Date;
  write?: boolean;
}

export async function runContext(
  cwd: string,
  task: string,
  opts: ContextOptions = {},
): Promise<ContextReport> {
```

and inside the `try` block:

```typescript
    const now = opts.now ?? new Date();
    const report = buildReport(task, ranked, dangerous, rules, now);
    if (opts.write !== false) writeReport(cwd, report);
    return report;
```

Leave the early `dbPath` existence check, `loadConfig`, search/score/danger lines unchanged.

- [ ] **Step 4: Migrate the e2e call sites**

In `test/e2e.test.ts`, update the two calls that pass a positional `Date` (lines ~29 and ~36):

```typescript
const report = await runContext(work, 'add login with password', { now: new Date('2026-06-16T00:00:00Z') });
```
and
```typescript
const again = await runContext(work, 'add login with password', { now: new Date('2026-06-16T00:00:00Z') });
```

Leave the no-third-arg call (`runContext(fresh, 'anything')`) unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/run-context.test.ts test/e2e.test.ts`
Expected: PASS (2 new + existing e2e).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `src/commands/context.ts` errors, it is only because it passed a positional `now` — it does not; it calls `runContext(process.cwd(), args.task)`, which is still valid. No change expected.)

- [ ] **Step 7: Commit**

```bash
git add src/core/run-context.ts test/e2e.test.ts test/run-context.test.ts
git commit -m "feat: write-free option for runContext"
```

---

## Task 2: MCP server module (`buildServer`, find_reuse + scan)

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/mcp/server.ts`
- Test: `test/mcp.test.ts` (new)

**Interfaces:**
- Consumes: `runScan(cwd) => Promise<{ fileCount; symbolCount; changed; warnings: string[] }>`; `runContext(cwd, task, { write: false })`; `renderCodex(report)`.
- Produces: `buildServer(cwd: string, version: string): McpServer` — an `McpServer` with two registered tools (`find_reuse`, `scan`), not yet connected to any transport.

- [ ] **Step 1: Install the SDK**

Run: `npm install @modelcontextprotocol/sdk@^1`
Expected: `package.json` `dependencies` now includes `@modelcontextprotocol/sdk`.

- [ ] **Step 2: Write the failing test**

Create `test/mcp.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildServer } from '../src/mcp/server.js';
import { runInit } from '../src/core/run-init.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensei-mcp-'));
  runInit(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function connect(cwd: string): Promise<Client> {
  const server = buildServer(cwd, '0.0.0-test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? '').join('\n');
}

function seedLogin(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'src', 'auth', 'login.ts'),
    'export function login(email: string, password: string): boolean {\n  return Boolean(email && password);\n}\n',
  );
}

describe('sensei mcp server', () => {
  it('exposes exactly find_reuse and scan', async () => {
    const client = await connect(dir);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['find_reuse', 'scan']);
  });

  it('find_reuse returns markdown with a freshness line and a known candidate', async () => {
    seedLogin(dir);
    const client = await connect(dir);
    const res = await client.callTool({ name: 'find_reuse', arguments: { task: 'add login with password' } });
    const text = textOf(res);
    expect(text).toContain('> index:');
    expect(text).toContain('## Reuse these');
    expect(text).toContain('login');
  });

  it('scan returns a summary', async () => {
    const client = await connect(dir);
    const res = await client.callTool({ name: 'scan', arguments: {} });
    expect(textOf(res)).toMatch(/Scanned \d+ files/);
  });

  it('find_reuse on an unrelated task does not error', async () => {
    seedLogin(dir);
    const client = await connect(dir);
    const res = await client.callTool({ name: 'find_reuse', arguments: { task: 'xyzzy unrelated' } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(res)).toContain('## Reuse these');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL — cannot resolve `../src/mcp/server.js`.

- [ ] **Step 4: Implement `buildServer`**

Create `src/mcp/server.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runScan } from '../core/run-scan.js';
import { runContext } from '../core/run-context.js';
import { renderCodex } from '../exporters/codex.js';

/** Build the Sensei MCP server (no transport attached). */
export function buildServer(cwd: string, version: string): McpServer {
  const server = new McpServer({ name: 'sensei', version });

  server.registerTool(
    'find_reuse',
    {
      title: 'Find reuse candidates',
      description:
        'Search the indexed codebase for existing functions, classes, and symbols to reuse before writing new code for a task, plus high-impact files to avoid editing. Call this before implementing any feature or change.',
      inputSchema: { task: z.string().describe('Natural-language description of what you are about to build') },
    },
    async ({ task }) => {
      try {
        const scan = await runScan(cwd);
        const report = await runContext(cwd, task, { write: false });
        const warn = scan.warnings.length ? ` · ${scan.warnings.length} warnings` : '';
        const freshness = `> index: ${scan.fileCount} files · ${scan.changed} changed · ${scan.symbolCount} symbols${warn}`;
        return { content: [{ type: 'text', text: `${freshness}\n\n${renderCodex(report)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `find_reuse failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'scan',
    {
      title: 'Rebuild the code index',
      description:
        "Rebuild Sensei's local code index (incremental). Call after large external code changes if find_reuse results look stale.",
      inputSchema: {},
    },
    async () => {
      try {
        const r = await runScan(cwd);
        const warn = r.warnings.length ? `, ${r.warnings.length} warnings` : '';
        return {
          content: [{ type: 'text', text: `Scanned ${r.fileCount} files, ${r.symbolCount} symbols (${r.changed} changed${warn}).` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `scan failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}
```

> If the installed SDK rejects `registerTool` with a raw-shape `inputSchema`, the 1.x fallback is the variadic form `server.tool('find_reuse', { task: z.string() }, async ({ task }) => { ... })` (and `server.tool('scan', async () => { ... })` for the no-arg tool). The test (Step 2) is the arbiter — make it pass without changing its assertions.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/mcp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/mcp/server.ts test/mcp.test.ts
git commit -m "feat: MCP server with find_reuse and scan tools"
```

---

## Task 3: `sensei mcp` command + docs

**Files:**
- Create: `src/commands/mcp.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `buildServer(cwd, version)` (Task 2); `StdioServerTransport` from the SDK; oclif `this.config.version`.
- Produces: a `sensei mcp` CLI command that serves over stdio and stays alive until stdin closes.

- [ ] **Step 1: Implement the command**

Create `src/commands/mcp.ts`:

```typescript
import { Command } from '@oclif/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../mcp/server.js';

export default class Mcp extends Command {
  static description = 'Run an MCP server (stdio) exposing find_reuse and scan to AI agents.';
  static examples = ['<%= config.bin %> mcp'];

  async run(): Promise<void> {
    // stdout is the JSON-RPC transport — never write logs there. Use stderr only.
    const server = buildServer(process.cwd(), this.config.version);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`sensei mcp server ready (cwd: ${process.cwd()})\n`);
    // The stdio transport keeps stdin referenced, so the process stays alive
    // until the client closes the stream. Nothing else to do here.
  }
}
```

- [ ] **Step 2: Build so oclif discovers the command**

Run: `npm run build`
Expected: no errors; `dist/commands/mcp.js` exists (oclif globs `dist/commands`).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual stdio smoke test**

The command is stdio glue (the tool behavior is already covered by `test/mcp.test.ts`). Verify the wire is clean — a JSON-RPC `initialize` returns a response on **stdout**, while the "ready" line goes to **stderr**:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node bin/run.js mcp
```
Expected: a single JSON object on stdout whose `result.serverInfo.name` is `"sensei"`; the `sensei mcp server ready ...` line appears on stderr (and not interleaved into the stdout JSON). The process exits when stdin closes (the pipe ends).

- [ ] **Step 5: Add a README usage section**

Add to `README.md` (under the existing commands/usage area) a short section:

````markdown
## MCP server

Run Sensei as a Model Context Protocol server so an AI agent can pull reuse
context itself:

```bash
sensei mcp
```

It serves two tools over stdio:

- `find_reuse({ task })` — reuse candidates and high-impact files for a task (runs an incremental scan first, returns markdown).
- `scan()` — rebuild the local index on demand.

Register it with an MCP client (cwd = your repo root). Example (Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "sensei": { "command": "sensei", "args": ["mcp"] }
  }
}
```
````

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: all tests pass (existing + `run-context.test.ts` + `mcp.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/commands/mcp.ts README.md
git commit -m "feat: sensei mcp command (stdio MCP server)"
```

---

## Self-Review

**Spec coverage (design §1–§8):**
- §2 tool surface (`find_reuse` + `scan`) — Task 2. ✓
- §2 staleness (incremental scan in `find_reuse`) — Task 2 Step 4 (`runScan` before query). ✓
- §2 transport (stdio) — Task 3. ✓
- §2 output (markdown via `renderCodex`) — Task 2 handler. ✓
- §2 write-free query — Task 1. ✓
- §3 server identity `{name:'sensei', version}` — Task 2 Step 4. ✓
- §4 SDK API (registerTool, transports, in-memory test) — Tasks 2 & 3, with fallback note. ✓
- §5 file-by-file — every file mapped to a task. ✓
- §6 stdout-is-protocol / stderr-only — Task 3 Step 1 + manual smoke Step 4. ✓
- §6 error handling (try/catch → isError) — Task 2 handlers + Task 2 Step 2 unrelated-task test. ✓
- §6 no-index-yet (find_reuse scans first) — Task 2 handler order. ✓
- §7 testing (in-memory transport + run-context unit) — Tasks 1 & 2. ✓
- §8 release/README — README in Task 3; the `0.9.0` release runs after merge via the normal release flow (out of plan scope, like prior features).

**Placeholder scan:** none — every code step has complete code; the smoke test has an exact command and expected output. The one conditional ("if the SDK rejects raw-shape inputSchema") names the exact fallback and keeps the test as arbiter. ✓

**Type consistency:** `buildServer(cwd, version)`, `runContext(cwd, task, { now?, write? })`, `ContextOptions`, `IndexResult` fields (`fileCount`/`symbolCount`/`changed`/`warnings`), tool names (`find_reuse`/`scan`) identical across definition and use sites. ✓
