import { describe, expect, it } from 'vitest';

import { ScenarioStore } from '../src/scenario.js';

describe('ScenarioStore', () => {
  it('keeps deploy, metrics, logs, and source evidence causally aligned', () => {
    const store = new ScenarioStore();
    const deploy = store.getDeploy('9921');
    const metrics = store.queryMetrics(
      'checkout-svc',
      '2026-08-29T14:29:00.000Z',
      '2026-08-29T14:33:00.000Z',
      ['p99_ms', 'error_rate_pct', 'db_round_trips_p99'],
    );
    const logs = store.queryLogs(
      'checkout-svc',
      '2026-08-29T14:32:00.000Z',
      '2026-08-29T14:33:59.999Z',
      'ERROR',
    );
    const source = store.getSourceFile('checkout_service/orders.py', 49, 56);

    expect(deploy.deployed_at).toBe('2026-08-29T14:30:00.000Z');
    expect(metrics.points).toContainEqual(
      expect.objectContaining({
        timestamp: '2026-08-29T14:32:00.000Z',
        p99_ms: 5800,
        error_rate_pct: 9.8,
        db_round_trips_p99: 146,
      }),
    );
    expect(logs.lines[0]).toContain('CheckoutDeadlineExceeded');
    expect(source.content).toContain('for item in items:');
    expect(source.content).toContain('self._sleep(self._round_trip_seconds)');
  });

  it('enforces incident state transitions and emits ordered deterministic audit records', () => {
    const store = new ScenarioStore();

    expect(() =>
      store.resolve(
        'INC-4821',
        'operator',
        'Rollback verified and metrics recovered',
      ),
    ).toThrow('cannot transition from triggered to resolved');

    const acknowledged = store.acknowledge('INC-4821', 'operator');
    const rollbackEvent = store.recordExternalAction(
      'remediation.rollback_executed',
      'operator',
      {
        deploy_id: '9921',
        revert_sha: '28e1ff271805050952879b679067243ac2af2629',
      },
    );
    const resolved = store.resolve(
      'INC-4821',
      'operator',
      'Rollback verified and metrics recovered',
    );

    expect(acknowledged.incident.status).toBe('acknowledged');
    expect(rollbackEvent.action).toBe('remediation.rollback_executed');
    expect(resolved.incident.status).toBe('resolved');
    expect(
      store
        .listAudit('INC-4821')
        .events.map(({ sequence, action, timestamp }) => ({
          sequence,
          action,
          timestamp,
        })),
    ).toEqual([
      {
        sequence: 1,
        action: 'pagerduty.acknowledged',
        timestamp: '2026-08-29T14:35:01.000Z',
      },
      {
        sequence: 2,
        action: 'remediation.rollback_executed',
        timestamp: '2026-08-29T14:35:02.000Z',
      },
      {
        sequence: 3,
        action: 'pagerduty.resolved',
        timestamp: '2026-08-29T14:35:03.000Z',
      },
    ]);
  });

  it('rejects unknown services, deploys, incidents, files, and out-of-range source reads', () => {
    const store = new ScenarioStore();
    expect(() => store.getIncident('INC-9999')).toThrow('Unknown incident');
    expect(() =>
      store.listDeploys(
        'payments-svc',
        '2026-08-29T00:00:00Z',
        '2026-08-30T00:00:00Z',
      ),
    ).toThrow('Unknown service');
    expect(() => store.getDeploy('9999')).toThrow('Unknown deploy');
    expect(() => store.getSourceFile('checkout_service/secrets.py', 1)).toThrow(
      'Unknown source file',
    );
    expect(() =>
      store.getSourceFile('checkout_service/orders.py', 999),
    ).toThrow('exceeds checkout_service/orders.py length');
  });
});
