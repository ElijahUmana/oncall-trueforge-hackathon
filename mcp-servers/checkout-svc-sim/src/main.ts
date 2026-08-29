import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { buildServer } from './server.js';

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 8941;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535; received ${value}`,
    );
  }
  return port;
}

function startStdio(): void {
  const stdio = serveStdio(() => buildServer(), {
    onerror: error =>
      console.error(`[checkout-svc-sim] stdio error: ${error.message}`),
  });
  console.error('[checkout-svc-sim] serving MCP over stdio');

  const shutdown = async (signal: string) => {
    console.error(
      `[checkout-svc-sim] received ${signal}; closing stdio transport`,
    );
    await stdio.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function startHttp(): void {
  const host = '127.0.0.1';
  const port = parsePort(process.env.PORT);
  const handler = createMcpHandler(() => buildServer(), {
    responseMode: 'json',
    onerror: error =>
      console.error(`[checkout-svc-sim] MCP handler error: ${error.message}`),
  });
  const app = createMcpHonoApp({ host });
  app.get('/health', context =>
    context.json({ status: 'ok', transport: 'streamable-http' }),
  );
  app.all('/mcp', context => handler.fetch(context.req.raw));

  const httpServer = serve({ fetch: app.fetch, hostname: host, port }, () => {
    console.error(`[checkout-svc-sim] listening on http://${host}:${port}/mcp`);
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) {
      return;
    }
    closing = true;
    console.error(
      `[checkout-svc-sim] received ${signal}; closing HTTP transport`,
    );
    await handler.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close(error =>
        error === undefined ? resolve() : reject(error),
      );
    });
  };
  process.once(
    'SIGINT',
    () =>
      void shutdown('SIGINT').then(
        () => process.exit(0),
        error => {
          console.error(`[checkout-svc-sim] shutdown failed: ${String(error)}`);
          process.exit(1);
        },
      ),
  );
  process.once(
    'SIGTERM',
    () =>
      void shutdown('SIGTERM').then(
        () => process.exit(0),
        error => {
          console.error(`[checkout-svc-sim] shutdown failed: ${String(error)}`);
          process.exit(1);
        },
      ),
  );
}

if (process.argv.includes('--stdio')) {
  startStdio();
} else {
  startHttp();
}
