import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DurableRemediationCoordinator,
  type DurableRollbackExecutor,
  type PreparedRollback,
} from '../src/durable-remediation.js';
import {
  DurableStateStore,
  rollbackOperationId,
  type DurableIncident,
  type RollbackReservationInput,
} from '../src/durable-state.js';

const directories: string[] = [];
const deploySha = 'b9c9167e17ed9e5a1159edcadedf1e5349550dbc';
const revertSha = '0681dd9e6a6b28cc107cba56887b4ecf77e361b5';

const incident: DurableIncident = {
  id: 'INC-4821',
  service: 'checkout-svc',
  severity: 'high',
  summary: 'Checkout deadline failures',
  started_at: '2026-08-29T14:32:00.000Z',
  alerted_at: '2026-08-29T14:35:00.000Z',
  status: 'triggered',
  symptoms: { peak_p99_ms: 6813.7 },
};

const input: RollbackReservationInput = {
  incidentId: 'INC-4821',
  deployId: '9921',
  deployCommit: deploySha,
  repositoryUrl: 'https://github.com/ElijahUmana/oncall-demo-svc.git',
  branch: 'main',
  requestedBy: 'operator',
  reason: 'Deploy immediately preceded 503 deadline failures',
};

const prepared: PreparedRollback = {
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

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oncall-coordinator-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

function store(
  path: string,
  runtimeId: string,
  processId: number,
  isAlive: (pid: number) => boolean,
): DurableStateStore {
  const state = new DurableStateStore(path, {
    runtimeId,
    processId,
    isProcessAlive: isAlive,
  });
  state.initializeIncident(incident);
  return state;
}

function acknowledgedStore(path: string): DurableStateStore {
  const state = store(path, 'runtime-a', 1001, () => false);
  state.acknowledge('INC-4821', 'operator');
  return state;
}

function executor(
  remoteHead: () => string,
  prepare = vi.fn().mockResolvedValue(prepared),
  applyPrepared = vi.fn().mockResolvedValue({
    remoteSha: revertSha,
  }),
): DurableRollbackExecutor {
  return {
    inspectRemoteHead: vi.fn(() => Promise.resolve(remoteHead())),
    prepare,
    applyPrepared,
    discardPrepared: vi.fn(() => Promise.resolve()),
    discardSandbox: vi.fn(() => Promise.resolve()),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DurableRemediationCoordinator', () => {
  it('persists prepared revert and evidence before invoking push phase', async () => {
    const path = statePath();
    const state = acknowledgedStore(path);
    const operationId = rollbackOperationId(input);
    const applyPrepared = vi.fn(() => {
      const operation = state.getRollbackOperation(operationId);
      expect(operation?.status).toBe('prepared');
      expect(operation?.expected_revert_sha).toBe(revertSha);
      expect(operation?.pre_evidence).toEqual(prepared.preEvidence);
      expect(operation?.post_evidence).toEqual(prepared.postEvidence);
      return Promise.resolve({ remoteSha: revertSha });
    });
    const coordinator = new DurableRemediationCoordinator(
      state,
      executor(() => deploySha, undefined, applyPrepared),
    );

    const result = await coordinator.execute(input);
    expect(result.operation.status).toBe('applied');
    expect(applyPrepared).toHaveBeenCalledOnce();
    state.close();
  });

  it('reconciles a push that succeeded before the response crashed', async () => {
    const path = statePath();
    const state = acknowledgedStore(path);
    let remote = deploySha;
    const applyPrepared = vi.fn(() => {
      remote = revertSha;
      return Promise.reject(new Error('connection dropped after push'));
    });
    const coordinator = new DurableRemediationCoordinator(
      state,
      executor(() => remote, undefined, applyPrepared),
    );

    const result = await coordinator.execute(input);
    expect(result.recovered).toBe(true);
    expect(result.operation.status).toBe('applied');
    expect(result.operation.remote_sha).toBe(revertSha);
    expect(result.operation.cleanup_error).toBeUndefined();
    expect(state.listAudit('INC-4821').at(-1)?.action).toBe(
      'remediation.rollback_executed',
    );
    state.close();
  });

  it('recovers a prepared operation after restart when remote is revert SHA', async () => {
    const path = statePath();
    const first = acknowledgedStore(path);
    const reservation = first.reserveRollback(input);
    first.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: prepared.sandboxId,
      revertSha: prepared.revertSha,
      preEvidence: prepared.preEvidence,
      postEvidence: prepared.postEvidence,
    });
    first.close();

    const restarted = store(path, 'runtime-b', 2002, () => false);
    const prepare = vi.fn();
    const apply = vi.fn();
    const coordinator = new DurableRemediationCoordinator(
      restarted,
      executor(() => revertSha, prepare, apply),
    );

    const result = await coordinator.execute(input);
    expect(result.recovered).toBe(true);
    expect(result.operation.status).toBe('applied');
    expect(prepare).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    restarted.close();
  });

  it('resumes deterministic prepare and push after restart when remote is deploy SHA', async () => {
    const path = statePath();
    const first = acknowledgedStore(path);
    const reservation = first.reserveRollback(input);
    first.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: prepared.sandboxId,
      revertSha: prepared.revertSha,
      preEvidence: prepared.preEvidence,
      postEvidence: prepared.postEvidence,
    });
    first.close();

    const restarted = store(path, 'runtime-b', 2002, () => false);
    const prepare = vi.fn().mockResolvedValue(prepared);
    const apply = vi.fn().mockResolvedValue({
      remoteSha: revertSha,
    });
    const discardSandbox = vi.fn(() => Promise.resolve());
    const coordinator = new DurableRemediationCoordinator(restarted, {
      ...executor(() => deploySha, prepare, apply),
      discardSandbox,
    });

    const result = await coordinator.execute(input);
    expect(result.operation.status).toBe('applied');
    expect(discardSandbox).toHaveBeenCalledWith('sandbox-a');
    expect(prepare).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    restarted.close();
  });

  it('rejects retry when remote HEAD is neither deploy nor prepared revert', async () => {
    const path = statePath();
    const first = acknowledgedStore(path);
    const reservation = first.reserveRollback(input);
    first.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: prepared.sandboxId,
      revertSha: prepared.revertSha,
      preEvidence: prepared.preEvidence,
      postEvidence: prepared.postEvidence,
    });
    first.close();

    const restarted = store(path, 'runtime-b', 2002, () => false);
    const coordinator = new DurableRemediationCoordinator(
      restarted,
      executor(() => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    );

    await expect(coordinator.execute(input)).rejects.toThrow(
      'cannot reconcile remote HEAD',
    );
    expect(
      restarted.getRollbackOperation(reservation.operation.operation_id)
        ?.status,
    ).toBe('conflict');
    expect(restarted.listAudit('INC-4821').at(-1)?.action).toBe(
      'remediation.rollback_conflict',
    );
    await expect(coordinator.execute(input)).rejects.toThrow(
      'is in conflict and requires operator intervention',
    );
    restarted.close();
  });

  it('cleans a crash-window allocated sandbox before preparing a replacement', async () => {
    const path = statePath();
    const first = acknowledgedStore(path);
    const reservation = first.reserveRollback(input);
    first.markRollbackSandboxAllocated(
      reservation.operation.operation_id,
      reservation.operation.owner_token,
      'orphan-sandbox',
    );
    first.close();

    const restarted = store(path, 'runtime-b', 2002, () => false);
    const discardSandbox = vi.fn(() => Promise.resolve());
    const prepare = vi.fn().mockResolvedValue(prepared);
    const coordinator = new DurableRemediationCoordinator(restarted, {
      ...executor(() => deploySha, prepare),
      discardSandbox,
    });

    const result = await coordinator.execute(input);
    expect(result.operation.status).toBe('applied');
    expect(discardSandbox).toHaveBeenCalledWith('orphan-sandbox');
    expect(discardSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      prepare.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    restarted.close();
  });

  it('keeps deterministic regeneration mismatch terminal', async () => {
    const path = statePath();
    const first = acknowledgedStore(path);
    const reservation = first.reserveRollback(input);
    first.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: prepared.sandboxId,
      revertSha: prepared.revertSha,
      preEvidence: prepared.preEvidence,
      postEvidence: prepared.postEvidence,
    });
    first.close();

    const restarted = store(path, 'runtime-b', 2002, () => false);
    const changed = {
      ...prepared,
      revertSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const prepare = vi.fn().mockResolvedValue(changed);
    const discardPrepared = vi.fn(() => Promise.resolve());
    const coordinator = new DurableRemediationCoordinator(restarted, {
      ...executor(() => deploySha, prepare),
      discardPrepared,
    });

    await expect(coordinator.execute(input)).rejects.toThrow(
      'regenerated revert',
    );
    expect(
      restarted.getRollbackOperation(reservation.operation.operation_id)
        ?.status,
    ).toBe('conflict');
    expect(discardPrepared).toHaveBeenCalledWith(changed);
    restarted.close();
  });

  it('cleans prepared sandbox before releasing a failed push for retry', async () => {
    const path = statePath();
    const state = acknowledgedStore(path);
    const apply = vi.fn().mockRejectedValue(new Error('push rejected'));
    const discardPrepared = vi.fn(() => Promise.resolve());
    const coordinator = new DurableRemediationCoordinator(state, {
      ...executor(() => deploySha, undefined, apply),
      discardPrepared,
    });

    await expect(coordinator.execute(input)).rejects.toThrow('push rejected');
    expect(discardPrepared).toHaveBeenCalledWith(prepared);
    expect(state.getRollbackOperation(rollbackOperationId(input))?.status).toBe(
      'failed_pre_push',
    );
    state.close();
  });

  it('marks preparation failure pre-push and permits a new attempt', async () => {
    const path = statePath();
    const state = acknowledgedStore(path);
    const prepare = vi.fn().mockRejectedValue(new Error('sandbox failed'));
    const coordinator = new DurableRemediationCoordinator(
      state,
      executor(() => deploySha, prepare),
    );

    await expect(coordinator.execute(input)).rejects.toThrow('sandbox failed');
    const failed = state.getRollbackOperation(rollbackOperationId(input));
    expect(failed?.status).toBe('failed_pre_push');

    const retryExecutor = executor(() => deploySha);
    const retry = await new DurableRemediationCoordinator(
      state,
      retryExecutor,
    ).execute(input);
    expect(retry.operation.status).toBe('applied');
    expect(retry.operation.attempt).toBe(2);
    state.close();
  });
});
