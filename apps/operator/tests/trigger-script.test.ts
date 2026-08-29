import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const scriptUrl = new URL('../../../demo/trigger-alert.sh', import.meta.url);

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
});
