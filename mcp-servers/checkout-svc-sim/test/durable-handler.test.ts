import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';

import {
  type AppliedRollback,
  type DurableRollbackExecutor,
  type PreparedRollback,
} from '../src/durable-remediation.js';
import { ScenarioStore } from '../src/scenario.js';
import { buildServer } from '../src/server.js';

const revertSha = '0681dd9e6a6b28cc107cba56887b4ecf77e361b5';
const rollbackArguments = {
  incident_id: 'INC-4821',
  deploy_id: '9921',
  repository_url: 'https://github.com/ElijahUmana/oncall-demo-svc.git',
  branch: 'main',
  requested_by: 'operator',
  reason: 'Deploy immediately preceded 503 checkout deadline failures',
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function connected(
  store: ScenarioStore,
  executor: DurableRollbackExecutor,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildServer(store, executor);
  const client = new Client({ name: 'durable-handler-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return '';
      }
      const record = item as Record<string, unknown>;
      return typeof record.text === 'string' ? record.text : '';
    })
    .join('\n');
}

describe('rollback_execute durable handler integration', () => {
  it('persists reservation before prepare and blocks concurrent resolve', async () => {
    const gate = deferred<PreparedRollback>();
    const inspectRemoteHead = vi.fn(() =>
      Promise.resolve('b9c9167e17ed9e5a1159edcadedf1e5349550dbc'),
    );
    const prepare = vi.fn(() => gate.promise);
    const applyPrepared = vi.fn((): Promise<AppliedRollback> =>
      Promise.resolve({ remoteSha: revertSha }),
    );
    const store = new ScenarioStore();
    store.acknowledge('INC-4821', 'operator');
    const { client, close } = await connected(store, {
      inspectRemoteHead,
      prepare,
      applyPrepared,
      discardPrepared: vi.fn(() => Promise.resolve()),
      discardSandbox: vi.fn(() => Promise.resolve()),
    });

    try {
      const rollbackPromise = client.callTool({
        name: 'rollback_execute',
        arguments: rollbackArguments,
      });
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect(store.listAudit('INC-4821').events.at(-1)?.action).toBe(
        'remediation.rollback_reserved',
      );

      const resolve = await client.callTool({
        name: 'pagerduty_resolve',
        arguments: {
          incident_id: 'INC-4821',
          actor: 'operator',
          resolution: 'Attempted while rollback still running',
        },
      });
      expect(resolve.isError).toBe(true);
      expect(resultText(resolve.content)).toContain(
        'cannot resolve while rollback',
      );

      gate.resolve(prepared);
      const rollback = await rollbackPromise;
      expect(rollback.isError).not.toBe(true);
      const content = rollback.structuredContent as
        Record<string, unknown> | undefined;
      if (content === undefined) {
        throw new Error('Expected durable rollback structured content');
      }
      expect(content.remote_sha).toBe(revertSha);
      expect(content.sandbox_stopped).toBe(true);
      const auditEvent: unknown = content.audit_event;
      if (
        auditEvent === null ||
        typeof auditEvent !== 'object' ||
        Array.isArray(auditEvent)
      ) {
        throw new Error('Expected durable rollback audit event');
      }
      expect((auditEvent as Record<string, unknown>).action).toBe(
        'remediation.rollback_executed',
      );
    } finally {
      await close();
    }
  });

  it('returns terminal durable result on retry without executor re-entry', async () => {
    const prepare = vi.fn(() => Promise.resolve(prepared));
    const applyPrepared = vi.fn(() =>
      Promise.resolve({ remoteSha: revertSha }),
    );
    const executor: DurableRollbackExecutor = {
      inspectRemoteHead: vi.fn(() =>
        Promise.resolve('b9c9167e17ed9e5a1159edcadedf1e5349550dbc'),
      ),
      prepare,
      applyPrepared,
      discardPrepared: vi.fn(() => Promise.resolve()),
      discardSandbox: vi.fn(() => Promise.resolve()),
    };
    const store = new ScenarioStore();
    store.acknowledge('INC-4821', 'operator');
    const { client, close } = await connected(store, executor);

    try {
      const first = await client.callTool({
        name: 'rollback_execute',
        arguments: rollbackArguments,
      });
      expect(first.isError).not.toBe(true);
      store.resolve('INC-4821', 'operator', 'Verified closeout after rollback');
      const second = await client.callTool({
        name: 'rollback_execute',
        arguments: rollbackArguments,
      });
      expect(second.isError).not.toBe(true);
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(prepare).toHaveBeenCalledOnce();
      expect(applyPrepared).toHaveBeenCalledOnce();
    } finally {
      await close();
    }
  });
});
