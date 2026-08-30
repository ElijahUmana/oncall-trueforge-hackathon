import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DurableIncidentStatus = 'triggered' | 'acknowledged' | 'resolved';
export type RollbackOperationStatus =
  | 'reserved'
  | 'prepared'
  | 'applied'
  | 'applied_cleanup_failed'
  | 'failed_pre_push'
  | 'conflict';

export interface DurableIncident {
  id: string;
  service: string;
  severity: string;
  summary: string;
  started_at: string;
  alerted_at: string;
  status: DurableIncidentStatus;
  symptoms: Record<string, number>;
}

export interface DurableAuditEvent {
  sequence: number;
  timestamp: string;
  action: string;
  actor: string;
  incident_id: string;
  details: Record<string, unknown>;
}

export interface RollbackEvidenceRecord {
  requests: number;
  errors: number;
  error_rate: number;
  p99_ms: number;
  health: string;
}

export interface RollbackReservationInput {
  incidentId: string;
  deployId: string;
  deployCommit: string;
  repositoryUrl: string;
  branch: string;
  requestedBy: string;
  reason: string;
}

export interface PreparedRollbackInput {
  operationId: string;
  ownerToken: string;
  sandboxId: string;
  revertSha: string;
  preEvidence: RollbackEvidenceRecord;
  postEvidence: RollbackEvidenceRecord;
}

export interface AppliedRollbackInput {
  operationId: string;
  ownerToken: string;
  remoteSha: string;
  sandboxStopped: boolean;
  cleanupError?: string;
}

export interface RollbackOperation {
  operation_id: string;
  incident_id: string;
  deploy_id: string;
  deploy_commit: string;
  repository_url: string;
  branch: string;
  requested_by: string;
  reason: string;
  status: RollbackOperationStatus;
  owner_token: string;
  owner_pid: number;
  attempt: number;
  sandbox_id?: string;
  expected_revert_sha?: string;
  remote_sha?: string;
  pre_evidence?: RollbackEvidenceRecord;
  post_evidence?: RollbackEvidenceRecord;
  cleanup_error?: string;
  failure_message?: string;
  created_at: string;
  updated_at: string;
}

export interface RollbackReservation {
  mode: 'execute' | 'recover' | 'already_applied';
  operation: RollbackOperation;
}

interface DurableStateOptions {
  runtimeId?: string;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
}

interface IncidentRow extends Record<string, unknown> {
  state_json: string;
  status: string;
}

interface AuditRow extends Record<string, unknown> {
  sequence: number;
  timestamp: string;
  action: string;
  actor: string;
  incident_id: string;
  details_json: string;
}

interface OperationRow extends Record<string, unknown> {
  operation_id: string;
  incident_id: string;
  deploy_id: string;
  deploy_commit: string;
  repository_url: string;
  branch: string;
  requested_by: string;
  reason: string;
  status: string;
  owner_token: string;
  owner_pid: number;
  attempt: number;
  sandbox_id: string | null;
  expected_revert_sha: string | null;
  remote_sha: string | null;
  pre_evidence_json: string | null;
  post_evidence_json: string | null;
  cleanup_error: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

const activeOperationStatuses: readonly RollbackOperationStatus[] = [
  'reserved',
  'prepared',
];

export function rollbackOperationId(
  input: Pick<
    RollbackReservationInput,
    'incidentId' | 'deployId' | 'deployCommit' | 'repositoryUrl' | 'branch'
  >,
): string {
  const canonical = JSON.stringify({
    incident_id: input.incidentId,
    deploy_id: input.deployId,
    deploy_commit: input.deployCommit,
    repository_url: input.repositoryUrl,
    branch: input.branch,
  });
  return `rollback_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

export class DurableStateStore {
  readonly #database: DatabaseSync;
  readonly #runtimeId: string;
  readonly #processId: number;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #now: () => Date;

  constructor(path: string, options: DurableStateOptions = {}) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    try {
      this.#database = new DatabaseSync(path);
    } catch (error) {
      throw new Error(`Failed to open durable incident state at ${path}`, {
        cause: error,
      });
    }
    this.#runtimeId = options.runtimeId ?? randomUUID();
    this.#processId = options.processId ?? process.pid;
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessLiveness;
    this.#now = options.now ?? (() => new Date());
    this.#initializeSchema();
  }

  close(): void {
    this.#database.close();
  }

  initializeIncident(seed: DurableIncident): void {
    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO incidents (incident_id, state_json, status, revision)
           VALUES (?, ?, ?, 0)
           ON CONFLICT (incident_id) DO NOTHING`,
        )
        .run(seed.id, JSON.stringify(seed), seed.status);
    });
  }

  getIncident(incidentId: string): DurableIncident {
    const row = this.#database
      .prepare('SELECT state_json, status FROM incidents WHERE incident_id = ?')
      .get(incidentId) as IncidentRow | undefined;
    if (row === undefined) {
      throw new Error(`Unknown incident: ${incidentId}`);
    }
    const incident = parseJsonObject<DurableIncident>(
      row.state_json,
      `incident ${incidentId}`,
    );
    return structuredClone({
      ...incident,
      status: requireIncidentStatus(row.status),
    });
  }

  acknowledge(
    incidentId: string,
    actor: string,
  ): { incident: DurableIncident; audit_event: DurableAuditEvent } {
    return this.#transitionIncident(
      incidentId,
      'triggered',
      'acknowledged',
      actor,
      'pagerduty.acknowledged',
      { previous_status: 'triggered', status: 'acknowledged' },
    );
  }

  resolve(
    incidentId: string,
    actor: string,
    resolution: string,
  ): { incident: DurableIncident; audit_event: DurableAuditEvent } {
    return this.#transaction(() => {
      const active = this.#database
        .prepare(
          `SELECT operation_id FROM rollback_operations
           WHERE incident_id = ? AND status IN ('reserved', 'prepared')
           LIMIT 1`,
        )
        .get(incidentId) as { operation_id: string } | undefined;
      if (active !== undefined) {
        throw new Error(
          `Incident ${incidentId} cannot resolve while rollback ${active.operation_id} is in progress`,
        );
      }
      return this.#transitionIncidentInTransaction(
        incidentId,
        'acknowledged',
        'resolved',
        actor,
        'pagerduty.resolved',
        { previous_status: 'acknowledged', status: 'resolved', resolution },
      );
    });
  }

  recordExternalAction(
    incidentId: string,
    action: string,
    actor: string,
    details: Record<string, unknown>,
  ): DurableAuditEvent {
    return this.#transaction(() => {
      this.#requireIncidentRow(incidentId);
      return this.#appendAudit(incidentId, action, actor, details);
    });
  }

  listAudit(incidentId: string, afterSequence = 0): DurableAuditEvent[] {
    this.#requireIncidentRow(incidentId);
    const rows = this.#database
      .prepare(
        `SELECT sequence, timestamp, action, actor, incident_id, details_json
         FROM audit_events
         WHERE incident_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(incidentId, afterSequence) as unknown as AuditRow[];
    return rows.map(row => ({
      sequence: row.sequence,
      timestamp: row.timestamp,
      action: row.action,
      actor: row.actor,
      incident_id: row.incident_id,
      details: parseJsonObject<Record<string, unknown>>(
        row.details_json,
        `audit event ${row.sequence}`,
      ),
    }));
  }

  reserveRollback(input: RollbackReservationInput): RollbackReservation {
    const operationId = rollbackOperationId(input);
    return this.#transaction(() => {
      const incident = this.#requireIncidentRow(input.incidentId);
      const existing = this.#getOperationRow(operationId);
      if (existing !== undefined) {
        const operation = operationFromRow(existing);
        if (
          operation.status === 'applied' ||
          operation.status === 'applied_cleanup_failed'
        ) {
          return { mode: 'already_applied', operation };
        }
        if (operation.status === 'conflict') {
          throw new Error(
            `Rollback ${operation.operation_id} is in conflict and requires operator intervention: ${operation.failure_message ?? 'remote state diverged'}`,
          );
        }
      }
      if (requireIncidentStatus(incident.status) !== 'acknowledged') {
        throw new Error(
          `Rollback reservation requires acknowledged incident; ${input.incidentId} is ${incident.status}`,
        );
      }

      if (existing !== undefined) {
        const operation = operationFromRow(existing);
        if (activeOperationStatuses.includes(operation.status)) {
          if (
            operation.owner_token === this.#runtimeId ||
            this.#isProcessAlive(operation.owner_pid)
          ) {
            throw new Error(
              `Rollback ${operation.operation_id} is already in progress`,
            );
          }
          const now = this.#now().toISOString();
          this.#database
            .prepare(
              `UPDATE rollback_operations
               SET owner_token = ?, owner_pid = ?, attempt = attempt + 1, updated_at = ?
               WHERE operation_id = ?`,
            )
            .run(this.#runtimeId, this.#processId, now, operationId);
          const recovered = this.#requireOperation(operationId);
          this.#appendAudit(
            input.incidentId,
            'remediation.rollback_recovery_started',
            input.requestedBy,
            {
              operation_id: operationId,
              previous_owner_pid: operation.owner_pid,
              attempt: recovered.attempt,
              status: recovered.status,
            },
          );
          return {
            mode: 'recover',
            operation: recovered,
          };
        }
      }

      const competing = this.#database
        .prepare(
          `SELECT operation_id FROM rollback_operations
           WHERE incident_id = ? AND status IN ('reserved', 'prepared')
           LIMIT 1`,
        )
        .get(input.incidentId) as { operation_id: string } | undefined;
      if (competing !== undefined) {
        throw new Error(
          `Incident ${input.incidentId} already has rollback ${competing.operation_id} in progress`,
        );
      }

      const now = this.#now().toISOString();
      this.#database
        .prepare(
          `INSERT INTO rollback_operations (
             operation_id, incident_id, deploy_id, deploy_commit,
             repository_url, branch, requested_by, reason, status,
             owner_token, owner_pid, attempt, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 1, ?, ?)
           ON CONFLICT (operation_id) DO UPDATE SET
             requested_by = excluded.requested_by,
             reason = excluded.reason,
             status = 'reserved',
             owner_token = excluded.owner_token,
             owner_pid = excluded.owner_pid,
             attempt = rollback_operations.attempt + 1,
             sandbox_id = NULL,
             expected_revert_sha = NULL,
             remote_sha = NULL,
             pre_evidence_json = NULL,
             post_evidence_json = NULL,
             cleanup_error = NULL,
             failure_message = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(
          operationId,
          input.incidentId,
          input.deployId,
          input.deployCommit,
          input.repositoryUrl,
          input.branch,
          input.requestedBy,
          input.reason,
          this.#runtimeId,
          this.#processId,
          now,
          now,
        );
      const operation = this.#requireOperation(operationId);
      this.#appendAudit(
        input.incidentId,
        'remediation.rollback_reserved',
        input.requestedBy,
        {
          operation_id: operationId,
          deploy_id: input.deployId,
          deploy_commit: input.deployCommit,
          repository_url: input.repositoryUrl,
          branch: input.branch,
          attempt: operation.attempt,
        },
      );
      return {
        mode: 'execute',
        operation,
      };
    });
  }

  markRollbackSandboxAllocated(
    operationId: string,
    ownerToken: string,
    sandboxId: string,
  ): RollbackOperation {
    return this.#transaction(() => {
      const operation = this.#requireOwnedActiveOperation(
        operationId,
        ownerToken,
        'reserved',
      );
      this.#database
        .prepare(
          `UPDATE rollback_operations
           SET sandbox_id = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(sandboxId, this.#now().toISOString(), operation.operation_id);
      return this.#requireOperation(operation.operation_id);
    });
  }

  clearRollbackSandbox(
    operationId: string,
    ownerToken: string,
  ): RollbackOperation {
    return this.#transaction(() => {
      const operation = this.#requireOwnedActiveOperation(
        operationId,
        ownerToken,
      );
      this.#database
        .prepare(
          `UPDATE rollback_operations
           SET sandbox_id = NULL, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(this.#now().toISOString(), operation.operation_id);
      return this.#requireOperation(operation.operation_id);
    });
  }

  markRollbackPrepared(input: PreparedRollbackInput): RollbackOperation {
    return this.#transaction(() => {
      const operation = this.#requireOwnedActiveOperation(
        input.operationId,
        input.ownerToken,
      );
      this.#database
        .prepare(
          `UPDATE rollback_operations
           SET status = 'prepared', sandbox_id = ?, expected_revert_sha = ?,
               pre_evidence_json = ?, post_evidence_json = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(
          input.sandboxId,
          input.revertSha,
          JSON.stringify(input.preEvidence),
          JSON.stringify(input.postEvidence),
          this.#now().toISOString(),
          operation.operation_id,
        );
      return this.#requireOperation(operation.operation_id);
    });
  }

  markRollbackApplied(input: AppliedRollbackInput): {
    operation: RollbackOperation;
    audit_event: DurableAuditEvent;
  } {
    return this.#transaction(() => {
      const operation = this.#requireOwnedActiveOperation(
        input.operationId,
        input.ownerToken,
        'prepared',
      );
      if (operation.expected_revert_sha !== input.remoteSha) {
        throw new Error(
          `Rollback ${operation.operation_id} remote SHA ${input.remoteSha} does not match prepared revert ${operation.expected_revert_sha}`,
        );
      }
      const status: RollbackOperationStatus = input.sandboxStopped
        ? 'applied'
        : 'applied_cleanup_failed';
      const action = input.sandboxStopped
        ? 'remediation.rollback_executed'
        : 'remediation.rollback_executed_cleanup_failed';
      this.#database
        .prepare(
          `UPDATE rollback_operations
           SET status = ?, remote_sha = ?, cleanup_error = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(
          status,
          input.remoteSha,
          input.cleanupError ?? null,
          this.#now().toISOString(),
          operation.operation_id,
        );
      const updated = this.#requireOperation(operation.operation_id);
      const auditEvent = this.#appendAudit(
        operation.incident_id,
        action,
        operation.requested_by,
        {
          operation_id: operation.operation_id,
          deploy_id: operation.deploy_id,
          repository_url: operation.repository_url,
          branch: operation.branch,
          revert_sha: operation.expected_revert_sha,
          remote_sha: input.remoteSha,
          rollback_applied: true,
          retryable: false,
          sandbox_stopped: input.sandboxStopped,
          ...(input.cleanupError !== undefined && {
            cleanup_error: input.cleanupError,
          }),
        },
      );
      return { operation: updated, audit_event: auditEvent };
    });
  }

  markRollbackPrePushFailure(
    operationId: string,
    ownerToken: string,
    failureMessage: string,
  ): RollbackOperation {
    return this.#transaction(() => {
      const operation = this.#requireOwnedActiveOperation(
        operationId,
        ownerToken,
      );
      this.#database
        .prepare(
          `UPDATE rollback_operations
           SET status = 'failed_pre_push', failure_message = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(failureMessage, this.#now().toISOString(), operation.operation_id);
      this.#appendAudit(
        operation.incident_id,
        'remediation.rollback_failed_pre_push',
        operation.requested_by,
        {
          operation_id: operation.operation_id,
          deploy_id: operation.deploy_id,
          retryable: true,
          failure_message: failureMessage,
        },
      );
      return this.#requireOperation(operation.operation_id);
    });
  }

  markRollbackConflict(
    operationId: string,
    ownerToken: string,
    failureMessage: string,
  ): RollbackOperation {
    return this.#transaction(() => {
      const operation = this.#requireOwnedActiveOperation(
        operationId,
        ownerToken,
      );
      this.#database
        .prepare(
          `UPDATE rollback_operations
           SET status = 'conflict', failure_message = ?, updated_at = ?
           WHERE operation_id = ?`,
        )
        .run(failureMessage, this.#now().toISOString(), operation.operation_id);
      this.#appendAudit(
        operation.incident_id,
        'remediation.rollback_conflict',
        operation.requested_by,
        {
          operation_id: operation.operation_id,
          deploy_id: operation.deploy_id,
          retryable: false,
          failure_message: failureMessage,
        },
      );
      return this.#requireOperation(operation.operation_id);
    });
  }

  getRollbackAudit(operationId: string): DurableAuditEvent | undefined {
    const rows = this.#database
      .prepare(
        `SELECT sequence, timestamp, action, actor, incident_id, details_json
         FROM audit_events
         WHERE action IN (
           'remediation.rollback_executed',
           'remediation.rollback_executed_cleanup_failed'
         )
         ORDER BY sequence DESC`,
      )
      .all() as unknown as AuditRow[];
    return rows
      .map(row => ({
        sequence: row.sequence,
        timestamp: row.timestamp,
        action: row.action,
        actor: row.actor,
        incident_id: row.incident_id,
        details: parseJsonObject<Record<string, unknown>>(
          row.details_json,
          `audit event ${row.sequence}`,
        ),
      }))
      .find(event => event.details.operation_id === operationId);
  }

  getRollbackOperation(operationId: string): RollbackOperation | undefined {
    const row = this.#getOperationRow(operationId);
    return row === undefined ? undefined : operationFromRow(row);
  }

  reset(seed: DurableIncident): void {
    this.#transaction(() => {
      this.#database.prepare('DELETE FROM rollback_operations').run();
      this.#database.prepare('DELETE FROM audit_events').run();
      this.#database
        .prepare(
          `INSERT INTO incidents (incident_id, state_json, status, revision)
           VALUES (?, ?, ?, 0)
           ON CONFLICT (incident_id) DO UPDATE SET
             state_json = excluded.state_json,
             status = excluded.status,
             revision = 0`,
        )
        .run(seed.id, JSON.stringify(seed), seed.status);
    });
  }

  #initializeSchema(): void {
    this.#database.exec('PRAGMA foreign_keys = ON');
    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = FULL');
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('triggered', 'acknowledged', 'resolved')),
        revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL,
        PRIMARY KEY (incident_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS rollback_operations (
        operation_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES incidents(incident_id),
        deploy_id TEXT NOT NULL,
        deploy_commit TEXT NOT NULL,
        repository_url TEXT NOT NULL,
        branch TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'reserved', 'prepared', 'applied', 'applied_cleanup_failed',
            'failed_pre_push', 'conflict'
          )
        ),
        owner_token TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        sandbox_id TEXT,
        expected_revert_sha TEXT,
        remote_sha TEXT,
        pre_evidence_json TEXT,
        post_evidence_json TEXT,
        cleanup_error TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_rollback_per_incident
      ON rollback_operations (incident_id)
      WHERE status IN ('reserved', 'prepared');
    `);
  }

  #transitionIncident(
    incidentId: string,
    expected: DurableIncidentStatus,
    next: DurableIncidentStatus,
    actor: string,
    action: string,
    details: Record<string, unknown>,
  ): { incident: DurableIncident; audit_event: DurableAuditEvent } {
    return this.#transaction(() =>
      this.#transitionIncidentInTransaction(
        incidentId,
        expected,
        next,
        actor,
        action,
        details,
      ),
    );
  }

  #transitionIncidentInTransaction(
    incidentId: string,
    expected: DurableIncidentStatus,
    next: DurableIncidentStatus,
    actor: string,
    action: string,
    details: Record<string, unknown>,
  ): { incident: DurableIncident; audit_event: DurableAuditEvent } {
    const row = this.#requireIncidentRow(incidentId);
    const current = requireIncidentStatus(row.status);
    if (current !== expected) {
      throw new Error(
        `Incident ${incidentId} cannot transition from ${current} to ${next}`,
      );
    }
    const state = parseJsonObject<DurableIncident>(
      row.state_json,
      `incident ${incidentId}`,
    );
    const incident: DurableIncident = { ...state, status: next };
    const update = this.#database
      .prepare(
        `UPDATE incidents
         SET state_json = ?, status = ?, revision = revision + 1
         WHERE incident_id = ? AND status = ?`,
      )
      .run(JSON.stringify(incident), next, incidentId, expected);
    if (Number(update.changes) !== 1) {
      throw new Error(
        `Incident ${incidentId} transition lost a concurrent race`,
      );
    }
    const auditEvent = this.#appendAudit(incidentId, action, actor, details);
    return { incident: structuredClone(incident), audit_event: auditEvent };
  }

  #appendAudit(
    incidentId: string,
    action: string,
    actor: string,
    details: Record<string, unknown>,
  ): DurableAuditEvent {
    const sequenceRow = this.#database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
         FROM audit_events WHERE incident_id = ?`,
      )
      .get(incidentId) as { sequence: number };
    const event: DurableAuditEvent = {
      sequence: sequenceRow.sequence,
      timestamp: new Date(
        Date.parse('2026-08-29T14:35:00.000Z') + sequenceRow.sequence * 1000,
      ).toISOString(),
      action,
      actor,
      incident_id: incidentId,
      details: structuredClone(details),
    };
    this.#database
      .prepare(
        `INSERT INTO audit_events
         (incident_id, sequence, timestamp, action, actor, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.incident_id,
        event.sequence,
        event.timestamp,
        event.action,
        event.actor,
        JSON.stringify(event.details),
      );
    return event;
  }

  #requireIncidentRow(incidentId: string): IncidentRow {
    const row = this.#database
      .prepare('SELECT state_json, status FROM incidents WHERE incident_id = ?')
      .get(incidentId) as IncidentRow | undefined;
    if (row === undefined) {
      throw new Error(`Unknown incident: ${incidentId}`);
    }
    return row;
  }

  #getOperationRow(operationId: string): OperationRow | undefined {
    return this.#database
      .prepare('SELECT * FROM rollback_operations WHERE operation_id = ?')
      .get(operationId) as OperationRow | undefined;
  }

  #requireOperation(operationId: string): RollbackOperation {
    const row = this.#getOperationRow(operationId);
    if (row === undefined) {
      throw new Error(`Unknown rollback operation: ${operationId}`);
    }
    return operationFromRow(row);
  }

  #requireOwnedActiveOperation(
    operationId: string,
    ownerToken: string,
    expectedStatus?: RollbackOperationStatus,
  ): RollbackOperation {
    const operation = this.#requireOperation(operationId);
    if (operation.owner_token !== ownerToken) {
      throw new Error(`Rollback ${operationId} is owned by another runtime`);
    }
    if (!activeOperationStatuses.includes(operation.status)) {
      throw new Error(
        `Rollback ${operationId} is not active; status is ${operation.status}`,
      );
    }
    if (expectedStatus !== undefined && operation.status !== expectedStatus) {
      throw new Error(
        `Rollback ${operationId} expected ${expectedStatus}; status is ${operation.status}`,
      );
    }
    return operation;
  }

  #transaction<T>(body: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Durable state transaction failed and rollback also failed',
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }
}

function operationFromRow(row: OperationRow): RollbackOperation {
  return {
    operation_id: row.operation_id,
    incident_id: row.incident_id,
    deploy_id: row.deploy_id,
    deploy_commit: row.deploy_commit,
    repository_url: row.repository_url,
    branch: row.branch,
    requested_by: row.requested_by,
    reason: row.reason,
    status: requireOperationStatus(row.status),
    owner_token: row.owner_token,
    owner_pid: row.owner_pid,
    attempt: row.attempt,
    ...(row.sandbox_id !== null && { sandbox_id: row.sandbox_id }),
    ...(row.expected_revert_sha !== null && {
      expected_revert_sha: row.expected_revert_sha,
    }),
    ...(row.remote_sha !== null && { remote_sha: row.remote_sha }),
    ...(row.pre_evidence_json !== null && {
      pre_evidence: parseJsonObject<RollbackEvidenceRecord>(
        row.pre_evidence_json,
        `rollback ${row.operation_id} pre-evidence`,
      ),
    }),
    ...(row.post_evidence_json !== null && {
      post_evidence: parseJsonObject<RollbackEvidenceRecord>(
        row.post_evidence_json,
        `rollback ${row.operation_id} post-evidence`,
      ),
    }),
    ...(row.cleanup_error !== null && { cleanup_error: row.cleanup_error }),
    ...(row.failure_message !== null && {
      failure_message: row.failure_message,
    }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requireIncidentStatus(value: string): DurableIncidentStatus {
  if (
    value === 'triggered' ||
    value === 'acknowledged' ||
    value === 'resolved'
  ) {
    return value;
  }
  throw new Error(`Corrupt incident status: ${value}`);
}

function requireOperationStatus(value: string): RollbackOperationStatus {
  if (
    value === 'reserved' ||
    value === 'prepared' ||
    value === 'applied' ||
    value === 'applied_cleanup_failed' ||
    value === 'failed_pre_push' ||
    value === 'conflict'
  ) {
    return value;
  }
  throw new Error(`Corrupt rollback operation status: ${value}`);
}

function parseJsonObject<T>(value: string, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Corrupt JSON in ${context}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Corrupt non-object JSON in ${context}`);
  }
  return parsed as T;
}

function defaultProcessLiveness(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw new Error(`Failed to determine liveness of process ${pid}`, {
      cause: error,
    });
  }
}
