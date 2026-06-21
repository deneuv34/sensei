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
