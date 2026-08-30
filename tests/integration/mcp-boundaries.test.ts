import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const packageDirectory = path.join(root, 'mcp-servers/checkout-svc-sim');
const tsxCli = path.join(packageDirectory, 'node_modules/tsx/dist/cli.mjs');
const mainSource = path.join(packageDirectory, 'src/main.ts');
const children = new Set<ChildProcess>();
const clients = new Set<Client>();
const statePaths = new Set<string>();

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Unable to allocate test port.'));
        return;
      }
      server.close(error =>
        error === undefined ? resolve(address.port) : reject(error),
      );
    });
  });
}

async function startConnector(requestedPort?: number) {
  const port = requestedPort ?? (await availablePort());
  const statePath = path.join(tmpdir(), `oncall-mcp-boundary-${port}.sqlite`);
  statePaths.add(statePath);
  const child = spawn(process.execPath, [tsxCli, mainSource], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      JIRA_API_TOKEN: '',
      JIRA_BASE_URL: '',
      JIRA_EMAIL: '',
      JIRA_PROJECT_KEY: '',
      PORT: String(port),
      CHECKOUT_MCP_STATE_PATH: statePath,
      SLACK_WEBHOOK_URL: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr?.on('data', chunk => {
    stderr += String(chunk);
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`MCP connector exited with ${child.exitCode}: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch {
      if (attempt === 99)
        throw new Error(`MCP connector did not start: ${stderr}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  const client = new Client({
    name: 'root-adversarial-test',
    version: '1.0.0',
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  clients.add(client);
  return { child, client, port };
}

async function stopConnector(child: ChildProcess, client: Client) {
  clients.delete(client);
  await client.close();
  children.delete(child);
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('MCP connector did not stop after SIGTERM.')),
      3_000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(
    [...clients].map(async client => {
      clients.delete(client);
      await client.close();
    }),
  );
  await Promise.all(
    [...children].map(async child => {
      children.delete(child);
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }),
  );
  await Promise.all(
    [...statePaths].flatMap(statePath => {
      statePaths.delete(statePath);
      return [statePath, `${statePath}-shm`, `${statePath}-wal`].map(file =>
        rm(file, { force: true }),
      );
    }),
  );
});

describe('MCP connector adversarial boundaries', () => {
  test('serves independent investigation reads concurrently', async () => {
    const { client } = await startConnector();
    const [logs, metrics, deploys, source] = await Promise.all([
      client.callTool({
        name: 'logs_query',
        arguments: {
          service: 'checkout-svc',
          start: '2026-08-29T14:29:00.000Z',
          end: '2026-08-29T14:40:00.000Z',
        },
      }),
      client.callTool({
        name: 'metrics_query',
        arguments: {
          service: 'checkout-svc',
          start: '2026-08-29T14:29:00.000Z',
          end: '2026-08-29T14:40:00.000Z',
          metrics: ['p99_ms', 'error_rate_pct'],
        },
      }),
      client.callTool({
        name: 'deploys_list',
        arguments: {
          service: 'checkout-svc',
          start: '2026-08-29T13:00:00.000Z',
          end: '2026-08-29T15:00:00.000Z',
        },
      }),
      client.callTool({
        name: 'code_get_file',
        arguments: { path: 'checkout_service/orders.py', start_line: 1 },
      }),
    ]);

    for (const result of [logs, metrics, deploys, source]) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
    }
  });

  test('persists incident state and audit across connector restart', async () => {
    const first = await startConnector();
    await first.client.callTool({
      name: 'pagerduty_acknowledge',
      arguments: { incident_id: 'INC-4821', actor: 'restart-test' },
    });
    await stopConnector(first.child, first.client);

    const second = await startConnector(first.port);
    const incident = await second.client.callTool({
      name: 'pagerduty_get_incident',
      arguments: { incident_id: 'INC-4821' },
    });
    expect(incident.structuredContent).toBeDefined();
    expect(JSON.stringify(incident.structuredContent)).toContain(
      '"status":"acknowledged"',
    );
    const audit = await second.client.callTool({
      name: 'audit_list',
      arguments: { incident_id: 'INC-4821', after_sequence: 0 },
    });
    expect(JSON.stringify(audit.structuredContent)).toContain(
      '"action":"pagerduty.acknowledged"',
    );
  });
});
