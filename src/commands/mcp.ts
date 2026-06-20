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
