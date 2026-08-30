import type { ProxyOptions } from 'vite';

type ProxyRequest = {
  setHeader(name: string, value: string): void;
};

type ProxyResponse = {
  headers: Record<string, string | string[] | undefined>;
};

export function applyProxyAuthorization(
  proxyRequest: ProxyRequest,
  token: string | undefined,
): void {
  if (token) proxyRequest.setHeader('authorization', `Bearer ${token}`);
}

export function applySseHeaders(proxyResponse: ProxyResponse): void {
  const contentType = proxyResponse.headers['content-type'];
  const serialized = Array.isArray(contentType)
    ? contentType.join(';')
    : contentType;
  if (!serialized?.includes('text/event-stream')) return;

  proxyResponse.headers['cache-control'] = 'no-cache';
  proxyResponse.headers['x-accel-buffering'] = 'no';
}

export function createApiProxy(target: string, token?: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', proxyRequest => {
        applyProxyAuthorization(proxyRequest, token);
      });
      proxy.on('proxyRes', proxyResponse => {
        applySseHeaders(proxyResponse);
      });
    },
  };
}
