import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DurableStateStore,
  rollbackOperationId,
  type DurableIncident,
  type RollbackEvidenceRecord,
  type RollbackReservationInput,
} from '../src/durable-state.js';

const temporaryDirectories: string[] = [];

const incident: DurableIncident = {
  id: 'INC-4821',
  service: 'checkout-svc',
  severity: 'high',
  summary: 'Checkout deadline failures',
  started_at: '2026-08-29T14:32:00.000Z',
  alerted_at: '2026-08-29T14:35:00.000Z',
  status: 'triggered',
  symptoms: { peak_p99_ms: 6813.7, peak_error_rate_pct: 12 },
};

const rollbackInput: RollbackReservationInput = {
  incidentId: 'INC-4821',
  deployId: '9921',
  deployCommit: 'b9c9167e17ed9e5a1159edcadedf1e5349550dbc',
  repositoryUrl: 'https://github.com/ElijahUmana/oncall-demo-svc.git',
  branch: 'main',
  requestedBy: 'operator',
  reason: 'Deploy immediately preceded 503 checkout deadline failures',
};

const preEvidence: RollbackEvidenceRecord = {
  requests: 25,
  errors: 3,
  error_rate: 0.12,
  p99_ms: 6813.7,
  health: 'degraded',
};

const postEvidence: RollbackEvidenceRecord = {
  requests: 25,
  errors: 0,
  error_rate: 0,
  p99_ms: 122.4,
  health: 'healthy',
};

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'oncall-durable-state-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.sqlite');
}

function openedStore(
  path: string,
  runtimeId: string,
  processId: number,
  alive: (pid: number) => boolean,
): DurableStateStore {
  return new DurableStateStore(path, {
    runtimeId,
    processId,
    isProcessAlive: alive,
  });
}

function initializedStore(path: string): DurableStateStore {
  const store = openedStore(path, 'runtime-a', 1001, () => false);
  store.initializeIncident(incident);
  return store;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DurableStateStore incident transitions', () => {
  it('atomically persists incident state and matching audit across restart', () => {
    const path = databasePath();
    const first = initializedStore(path);
    const acknowledged = first.acknowledge('INC-4821', 'operator');
    expect(acknowledged.incident.status).toBe('acknowledged');
    expect(acknowledged.audit_event.action).toBe('pagerduty.acknowledged');
    first.close();

    const restarted = openedStore(path, 'runtime-b', 1002, () => false);
    expect(restarted.getIncident('INC-4821').status).toBe('acknowledged');
    expect(restarted.listAudit('INC-4821')).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: 'pagerduty.acknowledged',
      }),
    ]);
    restarted.close();
  });

  it('allows only one acknowledgement transition across stores', () => {
    const path = databasePath();
    const first = initializedStore(path);
    const second = openedStore(path, 'runtime-b', 1002, () => true);

    first.acknowledge('INC-4821', 'operator-a');
    expect(() => second.acknowledge('INC-4821', 'operator-b')).toThrow(
      'cannot transition from acknowledged to acknowledged',
    );
    expect(first.listAudit('INC-4821')).toHaveLength(1);

    first.close();
    second.close();
  });
});

describe('DurableStateStore rollback reservations', () => {
  it('produces deterministic operation IDs from immutable mutation identity', () => {
    const changedRequester = {
      ...rollbackInput,
      requestedBy: 'someone-else',
      reason: 'A different explanation does not create a second mutation',
    };
    expect(rollbackOperationId(rollbackInput)).toBe(
      rollbackOperationId(changedRequester),
    );
    expect(
      rollbackOperationId({ ...rollbackInput, branch: 'release' }),
    ).not.toBe(rollbackOperationId(rollbackInput));
  });

  it('blocks concurrent rollback and incident resolution while owner is live', () => {
    const path = databasePath();
    const first = initializedStore(path);
    first.acknowledge('INC-4821', 'operator');
    const reservation = first.reserveRollback(rollbackInput);
    expect(reservation.mode).toBe('execute');
    expect(first.listAudit('INC-4821').at(-1)?.action).toBe(
      'remediation.rollback_reserved',
    );

    const competing = openedStore(path, 'runtime-b', 1002, pid => pid === 1001);
    expect(() => competing.reserveRollback(rollbackInput)).toThrow(
      'already in progress',
    );
    expect(() =>
      competing.resolve('INC-4821', 'operator', 'Rollback complete'),
    ).toThrow('cannot resolve while rollback');

    first.close();
    competing.close();
  });

  it('reclaims a stale reservation after process restart', () => {
    const path = databasePath();
    const first = initializedStore(path);
    first.acknowledge('INC-4821', 'operator');
    const initial = first.reserveRollback(rollbackInput);
    first.close();

    const restarted = openedStore(path, 'runtime-b', 2002, () => false);
    const recovered = restarted.reserveRollback(rollbackInput);
    expect(recovered.mode).toBe('recover');
    expect(recovered.operation.operation_id).toBe(
      initial.operation.operation_id,
    );
    expect(recovered.operation.attempt).toBe(2);
    expect(recovered.operation.owner_token).toBe('runtime-b');
    expect(restarted.listAudit('INC-4821').at(-1)?.action).toBe(
      'remediation.rollback_recovery_started',
    );
    restarted.close();
  });

  it('persists prepared revert evidence for crash reconciliation', () => {
    const path = databasePath();
    const first = initializedStore(path);
    first.acknowledge('INC-4821', 'operator');
    const reservation = first.reserveRollback(rollbackInput);
    first.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: 'sandbox-a',
      revertSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
      preEvidence,
      postEvidence,
    });
    first.close();

    const restarted = openedStore(path, 'runtime-b', 2002, () => false);
    const recovered = restarted.reserveRollback(rollbackInput);
    expect(recovered.mode).toBe('recover');
    expect(recovered.operation.status).toBe('prepared');
    expect(recovered.operation.expected_revert_sha).toBe(
      '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
    );
    expect(recovered.operation.pre_evidence).toEqual(preEvidence);
    expect(recovered.operation.post_evidence).toEqual(postEvidence);
    restarted.close();
  });

  it('marks verified remote mutation terminal and returns it on retry', () => {
    const path = databasePath();
    const store = initializedStore(path);
    store.acknowledge('INC-4821', 'operator');
    const reservation = store.reserveRollback(rollbackInput);
    const prepared = store.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: 'sandbox-a',
      revertSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
      preEvidence,
      postEvidence,
    });
    const applied = store.markRollbackApplied({
      operationId: prepared.operation_id,
      ownerToken: prepared.owner_token,
      remoteSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
      sandboxStopped: true,
    });
    expect(applied.operation.status).toBe('applied');
    expect(applied.audit_event.action).toBe('remediation.rollback_executed');

    const retry = store.reserveRollback(rollbackInput);
    expect(retry.mode).toBe('already_applied');
    expect(retry.operation.remote_sha).toBe(
      '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
    );
    store.close();
  });

  it('distinguishes verified mutation with cleanup warning', () => {
    const path = databasePath();
    const store = initializedStore(path);
    store.acknowledge('INC-4821', 'operator');
    const reservation = store.reserveRollback(rollbackInput);
    const prepared = store.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: 'sandbox-a',
      revertSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
      preEvidence,
      postEvidence,
    });
    const applied = store.markRollbackApplied({
      operationId: prepared.operation_id,
      ownerToken: prepared.owner_token,
      remoteSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
      sandboxStopped: false,
      cleanupError: 'stop unavailable',
    });

    expect(applied.operation.status).toBe('applied_cleanup_failed');
    expect(applied.audit_event.action).toBe(
      'remediation.rollback_executed_cleanup_failed',
    );
    expect(applied.audit_event.details).toEqual(
      expect.objectContaining({
        rollback_applied: true,
        retryable: false,
        sandbox_stopped: false,
        cleanup_error: 'stop unavailable',
      }),
    );
    store.close();
  });

  it('rejects a remote SHA that differs from prepared revert', () => {
    const path = databasePath();
    const store = initializedStore(path);
    store.acknowledge('INC-4821', 'operator');
    const reservation = store.reserveRollback(rollbackInput);
    const prepared = store.markRollbackPrepared({
      operationId: reservation.operation.operation_id,
      ownerToken: reservation.operation.owner_token,
      sandboxId: 'sandbox-a',
      revertSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
      preEvidence,
      postEvidence,
    });

    expect(() =>
      store.markRollbackApplied({
        operationId: prepared.operation_id,
        ownerToken: prepared.owner_token,
        remoteSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sandboxStopped: true,
      }),
    ).toThrow('does not match prepared revert');
    expect(store.getRollbackOperation(prepared.operation_id)?.status).toBe(
      'prepared',
    );
    store.close();
  });

  it('releases a pre-push failure for a new attempt', () => {
    const path = databasePath();
    const store = initializedStore(path);
    store.acknowledge('INC-4821', 'operator');
    const reservation = store.reserveRollback(rollbackInput);
    store.markRollbackPrePushFailure(
      reservation.operation.operation_id,
      reservation.operation.owner_token,
      'Daytona create failed',
    );

    const retry = store.reserveRollback(rollbackInput);
    expect(retry.mode).toBe('execute');
    expect(retry.operation.status).toBe('reserved');
    expect(retry.operation.attempt).toBe(2);
    const actions = store.listAudit('INC-4821').map(event => event.action);
    expect(actions).toContain('remediation.rollback_failed_pre_push');
    expect(actions.at(-1)).toBe('remediation.rollback_reserved');
    store.close();
  });
});
