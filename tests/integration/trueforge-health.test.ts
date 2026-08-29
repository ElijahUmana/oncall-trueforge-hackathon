import { describe, expect, test } from 'vitest';

const live = process.env.LIVE_INTEGRATION === '1';
const trueForgeBaseUrl =
  process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';

describe.skipIf(!live)('live TrueForge contract', () => {
  test('serves a healthy harness and chat application', async () => {
    const [healthResponse, uiResponse] = await Promise.all([
      fetch(new URL('/healthz', trueForgeBaseUrl)),
      fetch(new URL('/', trueForgeBaseUrl)),
    ]);
    expect(healthResponse.ok).toBe(true);
    expect(uiResponse.ok).toBe(true);
    expect(await uiResponse.text()).toContain('id="root"');
  });
});
