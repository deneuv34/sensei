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
