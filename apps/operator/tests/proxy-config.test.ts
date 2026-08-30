import { describe, expect, it, vi } from 'vitest';
import {
  applyProxyAuthorization,
  applySseHeaders,
  createApiProxy,
} from '../proxy-config';

describe('trusted TrueForge proxy', () => {
  it('leaves authentication untouched when no server token is configured', () => {
    const setHeader = vi.fn();

    applyProxyAuthorization({ setHeader }, undefined);

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('injects a bearer token only at the trusted proxy boundary', () => {
    const setHeader = vi.fn();

    applyProxyAuthorization({ setHeader }, 'server-secret');

    expect(setHeader).toHaveBeenCalledWith(
      'authorization',
      'Bearer server-secret',
    );
  });

  it('disables buffering only for SSE responses', () => {
    const sse = {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    };
    const json = { headers: { 'content-type': 'application/json' } };

    applySseHeaders(sse);
    applySseHeaders(json);

    expect(sse.headers).toMatchObject({
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    expect(json.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('configures both request authentication and response streaming hooks', () => {
    const handlers = new Map<string, (...args: never[]) => void>();
    const proxy = {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    const config = createApiProxy('http://127.0.0.1:8790', 'server-secret');

    config.configure?.(proxy as never, config);

    expect(proxy.on).toHaveBeenCalledTimes(2);
    const request = { setHeader: vi.fn() };
    handlers.get('proxyReq')?.(request as never);
    expect(request.setHeader).toHaveBeenCalledWith(
      'authorization',
      'Bearer server-secret',
    );
    const response = {
      headers: { 'content-type': 'text/event-stream' },
    };
    handlers.get('proxyRes')?.(response as never);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
  });
});
