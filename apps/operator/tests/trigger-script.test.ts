import { execFile } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptUrl = new URL('../../../demo/trigger-alert.sh', import.meta.url);
const scriptPath = decodeURIComponent(scriptUrl.pathname);
const servers: ReturnType<typeof createServer>[] = [];

async function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let contents = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      contents += chunk;
    });
    request.once('error', reject);
    request.once('end', () => {
      try {
        resolve(JSON.parse(contents) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe('trigger-alert.sh', () => {
  it('uses documented persistent session and background turn endpoints', async () => {
    const script = await readFile(scriptUrl, 'utf8');

    expect(script).toContain('/api/v1/sessions');
    expect(script).toContain('/turns');
    expect(script).toContain('stream: false');
    expect(script).toContain('oncall-incident-responder');
    expect(script).toContain('Do not execute a write or destructive action');
    expect(script).toContain('^INC-[0-9]+$');
    expect(script.indexOf('^INC-[0-9]+$')).toBeLessThan(
      script.indexOf('/api/v1/sessions'),
    );
  });

  it('JSON-encodes the agent and creates a background turn', async () => {
    const requests: Array<{ method?: string; url?: string; body: unknown }> =
      [];
    const baseUrl = await startServer((request, response) => {
      void body(request).then(payload => {
        requests.push({
          method: request.method,
          url: request.url,
          body: payload,
        });
        response.writeHead(request.url === '/api/v1/sessions' ? 201 : 200, {
          'content-type': 'application/json',
        });
        response.end(
          request.url === '/api/v1/sessions'
            ? '{"data":{"id":"session-1"}}'
            : '{"data":{"id":"turn-1"}}',
        );
      });
    });

    const result = await execFileAsync(scriptPath, ['INC-4821'], {
      env: {
        ...process.env,
        TRUEFORGE_BASE_URL: baseUrl,
        ONCALL_AGENT_NAME: 'oncall-"quoted"',
        ONCALL_OPERATOR_URL: 'http://operator.test',
      },
    });

    expect(result.stdout).toContain('session-1');
    expect(result.stdout).toContain(
      'Operator URL: http://operator.test/sessions/session-1',
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      method: 'POST',
      url: '/api/v1/sessions',
      body: { agent: { name: 'oncall-"quoted"' } },
    });
    expect(requests[1]).toMatchObject({
      method: 'POST',
      url: '/api/v1/sessions/session-1/turns',
    });
    expect(requests[1]?.body).toMatchObject({ stream: false });
  });

  it('deletes an empty session when turn creation fails', async () => {
    const requests: string[] = [];
    const baseUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === 'POST' && request.url === '/api/v1/sessions') {
        void body(request).then(() => {
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end('{"data":{"id":"session-1"}}');
        });
        return;
      }
      if (request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
        return;
      }
      void body(request).then(() => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"turn failed"}');
      });
    });

    await expect(
      execFileAsync(scriptPath, ['INC-4821'], {
        env: { ...process.env, TRUEFORGE_BASE_URL: baseUrl },
      }),
    ).rejects.toMatchObject({ code: 22 });
    expect(requests).toEqual([
      'POST /api/v1/sessions',
      'POST /api/v1/sessions/session-1/turns',
      'DELETE /api/v1/sessions/session-1',
    ]);
  });
});
