import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');

async function runScript(name: string) {
  return execFileAsync(process.execPath, [path.join(root, 'scripts', name)], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

describe('engineering policy', () => {
  test.each([
    ['verify-env.mjs', 'environment variable contracts'],
    ['verify-client-env.mjs', 'No client-exposed credential'],
    ['verify-secret-hygiene.mjs', 'no credential patterns detected'],
    ['verify-rollback-identity.mjs', 'Rollback identity aligned'],
    ['verify-repository-layout.mjs', 'Repository layout valid'],
    ['verify-remediation-contract.mjs', 'Remediation contract aligned'],
    ['verify-surfaces.mjs', 'Surface matrix valid'],
  ])('%s passes', async (script, expectedOutput) => {
    const { stderr, stdout } = await runScript(script);
    expect(stderr).toBe('');
    expect(stdout).toContain(expectedOutput);
  });
});
