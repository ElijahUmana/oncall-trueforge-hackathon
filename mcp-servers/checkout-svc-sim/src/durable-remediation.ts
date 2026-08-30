import {
  type DurableAuditEvent,
  type DurableStateStore,
  type RollbackEvidenceRecord,
  type RollbackOperation,
  type RollbackReservationInput,
} from './durable-state.js';

export interface PreparedRollback {
  sandboxId: string;
  revertSha: string;
  preEvidence: RollbackEvidenceRecord;
  postEvidence: RollbackEvidenceRecord;
}

export interface AppliedRollback {
  remoteSha: string;
}

export interface DurableRollbackExecutor {
  inspectRemoteHead(input: RollbackReservationInput): Promise<string>;
  prepare(
    input: RollbackReservationInput,
    operationId: string,
    onSandboxCreated: (sandboxId: string) => void,
  ): Promise<PreparedRollback>;
  applyPrepared(
    input: RollbackReservationInput,
    operationId: string,
    prepared: PreparedRollback,
  ): Promise<AppliedRollback>;
  discardPrepared(prepared: PreparedRollback): Promise<void>;
  discardSandbox(sandboxId: string): Promise<void>;
}

export interface DurableRollbackResult {
  operation: RollbackOperation;
  auditEvent: DurableAuditEvent;
  recovered: boolean;
}

export class DurableRemediationCoordinator {
  constructor(
    private readonly state: DurableStateStore,
    private readonly executor: DurableRollbackExecutor,
  ) {}

  async execute(
    input: RollbackReservationInput,
  ): Promise<DurableRollbackResult> {
    const reservation = this.state.reserveRollback(input);
    if (reservation.mode === 'already_applied') {
      return {
        operation: reservation.operation,
        auditEvent: this.#requireTerminalAudit(reservation.operation),
        recovered: true,
      };
    }

    let operation = reservation.operation;
    let preparedPersisted = operation.status === 'prepared';
    if (reservation.mode === 'recover') {
      const recovered = await this.#reconcileRemote(input, operation);
      if (recovered !== undefined) {
        return {
          operation: recovered,
          auditEvent: this.#requireTerminalAudit(recovered),
          recovered: true,
        };
      }
      if (operation.sandbox_id !== undefined) {
        try {
          await this.executor.discardSandbox(operation.sandbox_id);
          operation = this.state.clearRollbackSandbox(
            operation.operation_id,
            operation.owner_token,
          );
        } catch (error) {
          throw new Error(
            `Rollback ${operation.operation_id} could not clean up its prior allocated sandbox`,
            { cause: error },
          );
        }
      }
    }

    try {
      const prepared = await this.executor.prepare(
        input,
        operation.operation_id,
        sandboxId => {
          operation = this.state.markRollbackSandboxAllocated(
            operation.operation_id,
            operation.owner_token,
            sandboxId,
          );
        },
      );
      if (
        operation.expected_revert_sha !== undefined &&
        operation.expected_revert_sha !== prepared.revertSha
      ) {
        const message = `Rollback ${operation.operation_id} regenerated revert ${prepared.revertSha}, expected ${operation.expected_revert_sha}`;
        operation = this.state.markRollbackConflict(
          operation.operation_id,
          operation.owner_token,
          message,
        );
        await this.#discardPrepared(prepared, new Error(message));
        throw new Error(message);
      }
      try {
        operation = this.state.markRollbackPrepared({
          operationId: operation.operation_id,
          ownerToken: operation.owner_token,
          sandboxId: prepared.sandboxId,
          revertSha: prepared.revertSha,
          preEvidence: prepared.preEvidence,
          postEvidence: prepared.postEvidence,
        });
      } catch (checkpointError) {
        await this.#discardPrepared(prepared, checkpointError);
        throw checkpointError;
      }
      preparedPersisted = true;
      const applied = await this.executor.applyPrepared(
        input,
        operation.operation_id,
        prepared,
      );
      let sandboxStopped = false;
      let cleanupError: string | undefined;
      try {
        await this.executor.discardPrepared(prepared);
        sandboxStopped = true;
      } catch (error) {
        cleanupError = asError(error).message;
      }
      const terminal = this.state.markRollbackApplied({
        operationId: operation.operation_id,
        ownerToken: operation.owner_token,
        remoteSha: applied.remoteSha,
        sandboxStopped,
        ...(cleanupError !== undefined && { cleanupError }),
      });
      return {
        operation: terminal.operation,
        auditEvent: terminal.audit_event,
        recovered: false,
      };
    } catch (error) {
      if (operation.status === 'conflict') {
        throw error;
      }
      if (!preparedPersisted) {
        this.#recordPrePushFailure(operation, error);
        throw error;
      }
      return await this.#reconcileAfterApplyFailure(input, operation, error);
    }
  }

  async #reconcileRemote(
    input: RollbackReservationInput,
    operation: RollbackOperation,
  ): Promise<RollbackOperation | undefined> {
    const remoteHead = await this.executor.inspectRemoteHead(input);
    if (
      operation.status === 'prepared' &&
      operation.expected_revert_sha !== undefined &&
      remoteHead === operation.expected_revert_sha
    ) {
      let sandboxStopped = false;
      let cleanupError =
        'Recovered verified remote mutation after restart; prior sandbox stop could not be proven';
      if (
        operation.sandbox_id !== undefined &&
        operation.pre_evidence !== undefined &&
        operation.post_evidence !== undefined
      ) {
        try {
          await this.executor.discardPrepared({
            sandboxId: operation.sandbox_id,
            revertSha: operation.expected_revert_sha,
            preEvidence: operation.pre_evidence,
            postEvidence: operation.post_evidence,
          });
          sandboxStopped = true;
          cleanupError = '';
        } catch (error) {
          cleanupError = `Recovered verified remote mutation after restart; prepared sandbox stop failed: ${asError(error).message}`;
        }
      }
      return this.state.markRollbackApplied({
        operationId: operation.operation_id,
        ownerToken: operation.owner_token,
        remoteSha: remoteHead,
        sandboxStopped,
        ...(cleanupError.length > 0 && { cleanupError }),
      }).operation;
    }
    if (remoteHead === operation.deploy_commit) {
      return undefined;
    }
    const message = `Rollback ${operation.operation_id} cannot reconcile remote HEAD ${remoteHead}; expected deploy ${operation.deploy_commit}${operation.expected_revert_sha === undefined ? '' : ` or revert ${operation.expected_revert_sha}`}`;
    this.state.markRollbackConflict(
      operation.operation_id,
      operation.owner_token,
      message,
    );
    throw new Error(message);
  }

  async #reconcileAfterApplyFailure(
    input: RollbackReservationInput,
    operation: RollbackOperation,
    originalError: unknown,
  ): Promise<DurableRollbackResult> {
    try {
      const reconciled = await this.#reconcileRemote(input, operation);
      if (reconciled !== undefined) {
        return {
          operation: reconciled,
          auditEvent: this.#requireTerminalAudit(reconciled),
          recovered: true,
        };
      }
      const prepared = preparedFromOperation(operation);
      try {
        await this.executor.discardPrepared(prepared);
      } catch (cleanupError) {
        throw new AggregateError(
          [originalError, cleanupError],
          `Rollback ${operation.operation_id} failed before push and its prepared sandbox cleanup also failed`,
          { cause: cleanupError },
        );
      }
      this.#recordPrePushFailure(operation, originalError);
      throw asError(originalError);
    } catch (reconciliationError) {
      if (reconciliationError === originalError) {
        throw reconciliationError;
      }
      throw new AggregateError(
        [originalError, reconciliationError],
        `Rollback ${operation.operation_id} failed and remote reconciliation also failed`,
        { cause: reconciliationError },
      );
    }
  }

  async #discardPrepared(
    prepared: PreparedRollback,
    primaryError: unknown,
  ): Promise<void> {
    try {
      await this.executor.discardPrepared(prepared);
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'Rollback preparation could not be checkpointed and its sandbox cleanup also failed',
        { cause: cleanupError },
      );
    }
  }

  #requireTerminalAudit(operation: RollbackOperation): DurableAuditEvent {
    const event = this.state.getRollbackAudit(operation.operation_id);
    if (event === undefined) {
      throw new Error(
        `Rollback ${operation.operation_id} is terminal but has no durable completion audit`,
      );
    }
    return event;
  }

  #recordPrePushFailure(operation: RollbackOperation, error: unknown): void {
    this.state.markRollbackPrePushFailure(
      operation.operation_id,
      operation.owner_token,
      asError(error).message,
    );
  }
}

function preparedFromOperation(operation: RollbackOperation): PreparedRollback {
  if (
    operation.sandbox_id === undefined ||
    operation.expected_revert_sha === undefined ||
    operation.pre_evidence === undefined ||
    operation.post_evidence === undefined
  ) {
    throw new Error(
      `Rollback ${operation.operation_id} is prepared without complete durable sandbox evidence`,
    );
  }
  return {
    sandboxId: operation.sandbox_id,
    revertSha: operation.expected_revert_sha,
    preEvidence: operation.pre_evidence,
    postEvidence: operation.post_evidence,
  };
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('Rollback failed with a non-Error value', { cause: value });
}
