import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DaytonaRollbackExecutor,
  ROLLBACK_BRANCH,
  ROLLBACK_REPOSITORY_URL,
} from '../src/rollback-executor.js';
import { type RollbackReservationInput } from '../src/durable-state.js';

const deployCommit = 'b9c9167e17ed9e5a1159edcadedf1e5349550dbc';
const revertSha = '0681dd9e6a6b28cc107cba56887b4ecf77e361b5';
const operationId = 'rollback_1234567890abcdef12345678';

const input: RollbackReservationInput = {
  incidentId: 'INC-4821',
  deployId: '9921',
  deployCommit,
  repositoryUrl: ROLLBACK_REPOSITORY_URL,
  branch: ROLLBACK_BRANCH,
  requestedBy: 'operator',
  reason: 'Deploy immediately preceded 503 deadline failures',
};

function preparedOutput(): string {
  return `logs\n__ONCALL_ROLLBACK_PREPARED__${JSON.stringify({
    pre_evidence: {
      requests: 25,
      errors: 3,
      error_rate: 0.12,
      p99_ms: 6813.7,
      health: 'degraded',
    },
    revert_sha: revertSha,
    post_evidence: {
      requests: 25,
      errors: 0,
      error_rate: 0,
      p99_ms: 122.4,
      health: 'healthy',
    },
  })}`;
}

interface FakeDaytona {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function fakeDaytona(): {
  daytona: FakeDaytona;
  createCodeRun: ReturnType<typeof vi.fn>;
  applyCodeRun: ReturnType<typeof vi.fn>;
  createStop: ReturnType<typeof vi.fn>;
  applyStop: ReturnType<typeof vi.fn>;
} {
  const createCodeRun = vi.fn().mockResolvedValue({
    exitCode: 0,
    result: preparedOutput(),
  });
  const applyCodeRun = vi.fn().mockResolvedValue({
    exitCode: 0,
    result: `logs\n__ONCALL_ROLLBACK_APPLIED__${JSON.stringify({ remote_sha: revertSha })}`,
  });
  const createStop = vi.fn().mockResolvedValue(undefined);
  const applyStop = vi.fn().mockResolvedValue(undefined);
  const created = {
    id: 'sandbox-a',
    process: { codeRun: createCodeRun },
    stop: createStop,
  };
  const resumed = {
    id: 'sandbox-a',
    process: { codeRun: applyCodeRun },
    stop: applyStop,
  };
  return {
    daytona: {
      create: vi.fn().mockResolvedValue(created),
      get: vi.fn().mockResolvedValue(resumed),
    },
    createCodeRun,
    applyCodeRun,
    createStop,
    applyStop,
  };
}

function configured(): void {
  vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
  vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
  vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DaytonaRollbackExecutor', () => {
  it('fails before Daytona construction when credentials are absent', async () => {
    const factory = vi.fn();
    const executor = new DaytonaRollbackExecutor(factory);
    await expect(executor.prepare(input, operationId, vi.fn())).rejects.toThrow(
      'DAYTONA_API_KEY is not configured',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a rollback target outside the approved repository', async () => {
    configured();
    const factory = vi.fn();
    const executor = new DaytonaRollbackExecutor(factory);
    await expect(
      executor.prepare(
        {
          ...input,
          repositoryUrl: 'https://github.com/attacker/other.git',
        },
        operationId,
        vi.fn(),
      ),
    ).rejects.toThrow('does not match the approved repository and branch');
    expect(factory).not.toHaveBeenCalled();
  });

  it('prepares deterministic revert and evidence without push credentials', async () => {
    configured();
    const { daytona, createCodeRun, createStop } = fakeDaytona();
    const executor = new DaytonaRollbackExecutor(() => daytona);

    const result = await executor.prepare(input, operationId, vi.fn());
    expect(result).toEqual({
      sandboxId: 'sandbox-a',
      revertSha,
      preEvidence: {
        requests: 25,
        errors: 3,
        error_rate: 0.12,
        p99_ms: 6813.7,
        health: 'degraded',
      },
      postEvidence: {
        requests: 25,
        errors: 0,
        error_rate: 0,
        p99_ms: 122.4,
        health: 'healthy',
      },
    });
    expect(daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: 'trueforge-build-test',
        ephemeral: true,
        labels: {
          purpose: 'oncall-approved-rollback',
          deploy: '9921',
          operation: operationId,
        },
      }),
      { timeout: 120 },
    );
    const [code, params] = createCodeRun.mock.calls[0] as [
      string,
      { env: Record<string, string> },
    ];
    expect(code).toContain('git revert --no-edit');
    expect(code).not.toContain('git push origin');
    expect(code).toContain('ROLLBACK_COMMIT_DATE');
    expect(params.env.GITHUB_DEMO_TOKEN).toBeUndefined();
    expect(createStop).not.toHaveBeenCalled();
  });

  it('stops preparation sandbox on pre-push failure', async () => {
    configured();
    const { daytona, createCodeRun, createStop } = fakeDaytona();
    createCodeRun.mockResolvedValue({ exitCode: 41, result: 'HEAD mismatch' });
    const executor = new DaytonaRollbackExecutor(() => daytona);

    await expect(executor.prepare(input, operationId, vi.fn())).rejects.toThrow(
      'preparation failed with exit code 41',
    );
    expect(createStop).toHaveBeenCalledWith(120, true);
  });

  it('pushes only a persisted prepared SHA and verifies remote', async () => {
    configured();
    const { daytona, applyCodeRun, applyStop } = fakeDaytona();
    const executor = new DaytonaRollbackExecutor(() => daytona);
    const prepared = {
      sandboxId: 'sandbox-a',
      revertSha,
      preEvidence: {
        requests: 25,
        errors: 3,
        error_rate: 0.12,
        p99_ms: 6813.7,
        health: 'degraded',
      },
      postEvidence: {
        requests: 25,
        errors: 0,
        error_rate: 0,
        p99_ms: 122.4,
        health: 'healthy',
      },
    };

    const result = await executor.applyPrepared(input, operationId, prepared);
    expect(result).toEqual({ remoteSha: revertSha });
    expect(daytona.get).toHaveBeenCalledWith('sandbox-a');
    const [code, params] = applyCodeRun.mock.calls[0] as [
      string,
      { env: Record<string, string> },
    ];
    expect(code).toContain('git push origin');
    expect(code).toContain('git ls-remote origin');
    expect(params.env.EXPECTED_REVERT_SHA).toBe(revertSha);
    expect(params.env.GITHUB_DEMO_TOKEN).toBe('github-test-token');
    expect(code).not.toContain('github-test-token');
    expect(applyStop).not.toHaveBeenCalled();
  });

  it('stops a prepared sandbox through the explicit discard phase', async () => {
    configured();
    const { daytona, applyStop } = fakeDaytona();
    const executor = new DaytonaRollbackExecutor(() => daytona);
    await executor.discardPrepared({
      sandboxId: 'sandbox-a',
      revertSha,
      preEvidence: {
        requests: 25,
        errors: 3,
        error_rate: 0.12,
        p99_ms: 6813.7,
        health: 'degraded',
      },
      postEvidence: {
        requests: 25,
        errors: 0,
        error_rate: 0,
        p99_ms: 122.4,
        health: 'healthy',
      },
    });
    expect(applyStop).toHaveBeenCalledWith(120, true);
  });

  it('inspects the remote branch without returning the token', async () => {
    configured();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ sha: revertSha }));
    const executor = new DaytonaRollbackExecutor(vi.fn(), request);

    await expect(executor.inspectRemoteHead(input)).resolves.toBe(revertSha);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toContain('/commits/main');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer github-test-token',
    );
  });
});
