import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = join(packageDirectory, 'node_modules/tsx/dist/cli.mjs');
const mainSource = join(packageDirectory, 'src/main.ts');
const mainBuild = join(packageDirectory, 'dist/src/main.js');
const children = new Set<ChildProcess>();
const clients = new Set<Client>();

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object, received ${String(value)}`);
  }
  return value as Record<string, unknown>;
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new Error('Expected MCP content array');
  }
  return content
    .map(item => {
      const record = asRecord(item);
      return record.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .join('\n');
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Unable to allocate test port'));
        return;
      }
      const { port } = address;
      server.close(error =>
        error === undefined ? resolve(port) : reject(error),
      );
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', chunk => {
    stderr += String(chunk);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited with ${child.exitCode}: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Startup race; the bounded retry below observes process exit and reports stderr.
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`HTTP server did not become healthy: ${stderr}`);
}

async function startHttpClient(
  compiled = false,
): Promise<{ client: Client; port: number }> {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    compiled ? [mainBuild] : [tsxCli, mainSource],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        PORT: String(port),
        SLACK_BOT_TOKEN: '',
        SLACK_CHANNEL_ID: '',
        SLACK_WEBHOOK_URL: '',
        JIRA_BASE_URL: '',
        JIRA_EMAIL: '',
        JIRA_API_TOKEN: '',
        JIRA_PROJECT_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  await waitForHealth(port, child);
  const client = new Client({
    name: 'checkout-svc-sim-http-test',
    version: '1.0.0',
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  clients.add(client);
  return { client, port };
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
      if (child.exitCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Child server did not stop after SIGTERM')),
          3000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }),
  );
});

describe('MCP transports', () => {
  it('serves the full tool contract and preserves state across Streamable HTTP requests', async () => {
    const { client } = await startHttpClient();
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      'audit_list',
      'code_get_file',
      'deploy_get',
      'deploys_list',
      'jira_create_issue',
      'logs_query',
      'metrics_query',
      'pagerduty_acknowledge',
      'pagerduty_get_incident',
      'pagerduty_resolve',
      'rollback_execute',
      'slack_post_message',
    ]);

    const evidenceCalls = await Promise.all([
      client.callTool({
        name: 'logs_query',
        arguments: {
          service: 'checkout-svc',
          start: '2026-08-29T14:32:00.000Z',
          end: '2026-08-29T14:35:00.000Z',
          level: 'ERROR',
        },
      }),
      client.callTool({
        name: 'metrics_query',
        arguments: {
          service: 'checkout-svc',
          start: '2026-08-29T14:29:00.000Z',
          end: '2026-08-29T14:35:00.000Z',
          metrics: ['p99_ms', 'error_rate_pct', 'db_round_trips_p99'],
        },
      }),
      client.callTool({
        name: 'deploys_list',
        arguments: {
          service: 'checkout-svc',
          start: '2026-08-29T13:00:00.000Z',
          end: '2026-08-29T14:35:00.000Z',
        },
      }),
      client.callTool({
        name: 'code_get_file',
        arguments: {
          path: 'checkout_service/orders.py',
          start_line: 49,
          end_line: 56,
        },
      }),
    ]);
    expect(evidenceCalls.every(result => result.isError !== true)).toBe(true);
    expect(resultText(evidenceCalls[0]?.content)).toContain(
      'CheckoutDeadlineExceeded',
    );
    expect(resultText(evidenceCalls[1]?.content)).toContain(
      'db_round_trips_p99',
    );
    expect(resultText(evidenceCalls[2]?.content)).toContain(
      'b9c9167e17ed9e5a1159edcadedf1e5349550dbc',
    );
    expect(resultText(evidenceCalls[3]?.content)).toContain(
      'for item in items:',
    );

    const acknowledged = await client.callTool({
      name: 'pagerduty_acknowledge',
      arguments: { incident_id: 'INC-4821', actor: 'integration-test' },
    });
    expect(acknowledged.isError).not.toBe(true);
    const acknowledgedContent = asRecord(acknowledged.structuredContent);
    expect(acknowledgedContent.incident).toEqual(
      expect.objectContaining({ status: 'acknowledged' }),
    );

    const rollback = await client.callTool({
      name: 'rollback_execute',
      arguments: {
        incident_id: 'INC-4821',
        deploy_id: '9921',
        requested_by: 'integration-test',
        reason: 'Deploy immediately preceded per-item database round trips',
      },
    });
    expect(rollback.isError).toBe(true);
    expect(resultText(rollback.content)).toContain(
      'DAYTONA_API_KEY is not configured',
    );

    const audit = await client.callTool({
      name: 'audit_list',
      arguments: { incident_id: 'INC-4821' },
    });
    expect(audit.structuredContent).toEqual({
      incident_id: 'INC-4821',
      events: [
        expect.objectContaining({
          sequence: 1,
          action: 'pagerduty.acknowledged',
        }),
      ],
    });
  });

  it('returns protocol tool errors for invalid transitions, schema violations, and absent external credentials', async () => {
    const { client } = await startHttpClient();

    const invalidTransition = await client.callTool({
      name: 'pagerduty_resolve',
      arguments: {
        incident_id: 'INC-4821',
        actor: 'integration-test',
        resolution: 'Rollback verified and metrics recovered',
      },
    });
    expect(invalidTransition.isError).toBe(true);
    expect(resultText(invalidTransition.content)).toContain(
      'cannot transition from triggered to resolved',
    );

    const invalidRange = await client.callTool({
      name: 'logs_query',
      arguments: {
        service: 'checkout-svc',
        start: '2026-08-29T14:40:00.000Z',
        end: '2026-08-29T14:30:00.000Z',
      },
    });
    expect(invalidRange.isError).toBe(true);
    expect(resultText(invalidRange.content)).toContain(
      'start must be at or before end',
    );

    const invalidOffset = await client.callTool({
      name: 'logs_query',
      arguments: {
        service: 'checkout-svc',
        start: '2026-08-29T14:30:00+00:00',
        end: '2026-08-29T14:40:00+00:00',
      },
    });
    expect(invalidOffset.isError).toBe(true);
    expect(resultText(invalidOffset.content)).toContain(
      'timestamp must be normalized UTC ending in Z',
    );

    const duplicateMetrics = await client.callTool({
      name: 'metrics_query',
      arguments: {
        service: 'checkout-svc',
        start: '2026-08-29T14:30:00.000Z',
        end: '2026-08-29T14:40:00.000Z',
        metrics: ['p99_ms', 'p99_ms'],
      },
    });
    expect(duplicateMetrics.isError).toBe(true);
    expect(resultText(duplicateMetrics.content)).toContain(
      'metrics must be unique',
    );

    const slack = await client.callTool({
      name: 'slack_post_message',
      arguments: {
        incident_id: 'INC-4821',
        channel: '#oncall-demo',
        text: 'RCA',
        actor: 'integration-test',
      },
    });
    expect(slack.isError).toBe(true);
    expect(resultText(slack.content)).toContain(
      'configure SLACK_BOT_TOKEN and SLACK_CHANNEL_ID, or SLACK_WEBHOOK_URL',
    );

    const jira = await client.callTool({
      name: 'jira_create_issue',
      arguments: {
        incident_id: 'INC-4821',
        summary: 'Follow-up',
        description: 'Add regression coverage',
        actor: 'integration-test',
      },
    });
    expect(jira.isError).toBe(true);
    expect(resultText(jira.content)).toContain(
      'missing JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY',
    );
  });

  it('enforces localhost Origin validation before dispatching MCP', async () => {
    const { port } = await startHttpClient();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }),
    });
    expect(response.status).toBe(403);
  });

  it('serves the compiled build with packaged scenario data', async () => {
    const { client } = await startHttpClient(true);
    const incident = await client.callTool({
      name: 'pagerduty_get_incident',
      arguments: { incident_id: 'INC-4821' },
    });
    const incidentContent = asRecord(incident.structuredContent);
    expect(incidentContent.incident).toEqual(
      expect.objectContaining({ id: 'INC-4821', status: 'triggered' }),
    );
  });

  it('serves tool calls over stdio and closes cleanly', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, mainSource, '--stdio'],
      cwd: packageDirectory,
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: '',
        SLACK_CHANNEL_ID: '',
        SLACK_WEBHOOK_URL: '',
        JIRA_BASE_URL: '',
        JIRA_EMAIL: '',
        JIRA_API_TOKEN: '',
        JIRA_PROJECT_KEY: '',
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'checkout-svc-sim-stdio-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    await client.connect(transport);
    clients.add(client);

    const incident = await client.callTool({
      name: 'pagerduty_get_incident',
      arguments: { incident_id: 'INC-4821' },
    });
    const incidentContent = asRecord(incident.structuredContent);
    expect(incidentContent.incident).toEqual(
      expect.objectContaining({ id: 'INC-4821', status: 'triggered' }),
    );
  });
});
