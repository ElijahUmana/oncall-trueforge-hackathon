import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DaytonaRollbackExecutor,
  type RollbackExecutionResult,
  type RollbackExecutor,
} from '../src/rollback-executor.js';
import { ScenarioStore } from '../src/scenario.js';
import { buildServer } from '../src/server.js';

const deployCommit = 'b9c9167e17ed9e5a1159edcadedf1e5349550dbc';
const revertSha = '28e1ff271805050952879b679067243ac2af2629';
const repositoryUrl =
  'https://github.com/ElijahUmana/oncall-demo-svc.git' as const;
const branch = 'main' as const;
const rollbackRequest = {
  deployId: '9921',
  deployCommit,
  repositoryUrl,
  branch,
};

interface FakeDaytona {
  create: ReturnType<typeof vi.fn>;
}

function verifiedOutput(overrides: Record<string, unknown> = {}): string {
  return `command logs\n__ONCALL_ROLLBACK_RESULT__${JSON.stringify({
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
      p99_ms: 90.8,
      health: 'healthy',
    },
    remote_sha: revertSha,
    tests_passed: true,
    ...overrides,
  })}`;
}

function fakeDaytona(response = { exitCode: 0, result: verifiedOutput() }): {
  daytona: FakeDaytona;
  codeRun: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const codeRun = vi.fn().mockResolvedValue(response);
  const stop = vi.fn().mockResolvedValue(undefined);
  const sandbox = { id: 'sandbox-123', process: { codeRun }, stop };
  const daytona: FakeDaytona = {
    create: vi.fn().mockResolvedValue(sandbox),
  };
  return { daytona, codeRun, stop };
}

async function connectedClient(
  store: ScenarioStore,
  executor: RollbackExecutor,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildServer(store, executor);
  const client = new Client({ name: 'rollback-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DaytonaRollbackExecutor', () => {
  it('fails before Daytona construction when credentials are absent', async () => {
    const factory = vi.fn();
    const executor = new DaytonaRollbackExecutor(factory);

    await expect(executor.execute(rollbackRequest)).rejects.toThrow(
      'DAYTONA_API_KEY is not configured',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a rollback target outside the approved repository and branch', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
    vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
    vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
    const factory = vi.fn();
    const executor = new DaytonaRollbackExecutor(factory);

    await expect(
      executor.execute({
        ...rollbackRequest,
        repositoryUrl: 'https://github.com/attacker/other.git' as typeof repositoryUrl,
      }),
    ).rejects.toThrow('does not match the approved repository and branch');
    expect(factory).not.toHaveBeenCalled();
  });

  it('executes and verifies the complete rollback transaction before stopping the sandbox', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
    vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
    vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
    const { daytona, codeRun, stop } = fakeDaytona();
    const executor = new DaytonaRollbackExecutor(() => daytona);

    const result = await executor.execute(rollbackRequest);

    expect(result).toEqual({
      repository_url: 'https://github.com/ElijahUmana/oncall-demo-svc.git',
      branch: 'main',
      sandbox_id: 'sandbox-123',
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
        p99_ms: 90.8,
        health: 'healthy',
      },
      remote_sha: revertSha,
      tests_passed: true,
      sandbox_stopped: true,
    });
    expect(daytona.create).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: 'trueforge-build-test',
        ephemeral: true,
        labels: { purpose: 'oncall-approved-rollback', deploy: '9921' },
      }),
      { timeout: 120 },
    );
    const [code, params, timeout] = codeRun.mock.calls[0] as [
      string,
      { env: Record<string, string> },
      number,
    ];
    expect(timeout).toBe(300);
    expect(params.env).toEqual(
      expect.objectContaining({
        DEPLOY_COMMIT: deployCommit,
        GITHUB_DEMO_TOKEN: 'github-test-token',
        GITHUB_REPOSITORY: repositoryUrl,
      }),
    );
    expect(code).toContain('mkdir -p /workspace');
    expect(code).toContain('cwd="/"');
    expect(code).toContain('["/bin/bash", "-lc", script]');
    expect(code).toContain('git clone --branch main --single-branch');
    expect(code).toContain(
      'EXPECTED_CHECKOUT_STATUS=503 ./verify-incident.sh',
    );
    expect(code).toContain('git reset --hard HEAD');
    expect(code).toContain('git revert --no-edit');
    expect(code).toContain('./run-tests.sh');
    expect(code).toContain(
      'EXPECTED_CHECKOUT_STATUS=201 ./verify-incident.sh',
    );
    expect(code).toContain('git push origin');
    expect(code).toContain('git ls-remote origin');
    expect(code).not.toContain('github-test-token');
    expect(stop).toHaveBeenCalledWith(120, true);
  });

  it('returns verified success with an explicit stop warning after the remote mutation', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
    vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
    vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
    const { daytona, stop } = fakeDaytona();
    stop.mockRejectedValue(new Error('stop unavailable'));
    const executor = new DaytonaRollbackExecutor(() => daytona);

    await expect(executor.execute(rollbackRequest)).resolves.toEqual(
      expect.objectContaining({
        remote_sha: revertSha,
        sandbox_stopped: false,
        cleanup_error: 'stop unavailable',
      }),
    );
  });

  it('rejects nonzero code runs and still stops the sandbox', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
    vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
    vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
    const { daytona, stop } = fakeDaytona({
      exitCode: 41,
      result: 'remote SHA mismatch',
    });
    const executor = new DaytonaRollbackExecutor(() => daytona);

    await expect(executor.execute(rollbackRequest)).rejects.toThrow(
      'exit code 41',
    );
    expect(stop).toHaveBeenCalledWith(120, true);
  });

  it('preserves execution and stop errors together', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
    vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
    vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
    const { daytona, stop } = fakeDaytona({
      exitCode: 41,
      result: 'remote SHA mismatch',
    });
    stop.mockRejectedValue(new Error('stop unavailable'));
    const executor = new DaytonaRollbackExecutor(() => daytona);

    const failure = await executor
      .execute(rollbackRequest)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[1]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toContain('exit code 41');
    expect((errors[1] as Error).message).toBe('stop unavailable');
  });

  it('rejects unverified recovery evidence', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'daytona-test-key');
    vi.stubEnv('GITHUB_DEMO_TOKEN', 'github-test-token');
    vi.stubEnv('DAYTONA_SNAPSHOT', 'trueforge-build-test');
    const { daytona } = fakeDaytona({
      exitCode: 0,
      result: verifiedOutput({
        post_evidence: {
          requests: 25,
          errors: 1,
          error_rate: 0.04,
          p99_ms: 1200,
          health: 'degraded',
        },
      }),
    });
    const executor = new DaytonaRollbackExecutor(() => daytona);

    await expect(executor.execute(rollbackRequest)).rejects.toThrow(
      'post-evidence did not verify recovery',
    );
  });
});

describe('rollback_execute tool', () => {
  it('does not invoke the executor before incident acknowledgement', async () => {
    const execute = vi.fn();
    const executor: RollbackExecutor = { execute };
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store, executor);
    try {
      const result = await client.callTool({
        name: 'rollback_execute',
        arguments: {
          incident_id: 'INC-4821',
          deploy_id: '9921',
          repository_url: repositoryUrl,
          branch,
          requested_by: 'operator',
          reason: 'Deploy immediately preceded per-item database round trips',
        },
      });
      expect(result.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(store.listAudit('INC-4821').events).toEqual([]);
    } finally {
      await close();
    }
  });

  it('returns verified execution evidence and audits only after executor success', async () => {
    const execution: RollbackExecutionResult = {
      repository_url: 'https://github.com/ElijahUmana/oncall-demo-svc.git',
      branch: 'main',
      sandbox_id: 'sandbox-123',
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
        p99_ms: 90.8,
        health: 'healthy',
      },
      remote_sha: revertSha,
      tests_passed: true,
      sandbox_stopped: true,
    };
    const execute = vi.fn().mockResolvedValue(execution);
    const executor: RollbackExecutor = { execute };
    const store = new ScenarioStore();
    store.acknowledge('INC-4821', 'operator');
    const { client, close } = await connectedClient(store, executor);
    try {
      const result = await client.callTool({
        name: 'rollback_execute',
        arguments: {
          incident_id: 'INC-4821',
          deploy_id: '9921',
          repository_url: repositoryUrl,
          branch,
          requested_by: 'operator',
          reason: 'Deploy immediately preceded per-item database round trips',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          incident_id: 'INC-4821',
          deploy_id: '9921',
          revert_sha: revertSha,
          remote_sha: revertSha,
          tests_passed: true,
        }),
      );
      expect(execute).toHaveBeenCalledWith({
        deployId: '9921',
        deployCommit,
        repositoryUrl,
        branch,
      });
      const events = store.listAudit('INC-4821').events;
      expect(events.at(-1)?.action).toBe('remediation.rollback_executed');
      expect(events.at(-1)?.details).toEqual(
        expect.objectContaining({
          revert_sha: revertSha,
          remote_sha: revertSha,
        }),
      );
    } finally {
      await close();
    }
  });

  it('does not audit executor failure as success', async () => {
    const executor: RollbackExecutor = {
      execute: vi
        .fn()
        .mockRejectedValue(new Error('Daytona rollback command failed')),
    };
    const store = new ScenarioStore();
    store.acknowledge('INC-4821', 'operator');
    const { client, close } = await connectedClient(store, executor);
    try {
      const result = await client.callTool({
        name: 'rollback_execute',
        arguments: {
          incident_id: 'INC-4821',
          deploy_id: '9921',
          repository_url: repositoryUrl,
          branch,
          requested_by: 'operator',
          reason: 'Deploy immediately preceded per-item database round trips',
        },
      });
      expect(result.isError).toBe(true);
      expect(store.listAudit('INC-4821').events).toHaveLength(1);
      expect(store.listAudit('INC-4821').events[0]?.action).toBe(
        'pagerduty.acknowledged',
      );
    } finally {
      await close();
    }
  });
});
