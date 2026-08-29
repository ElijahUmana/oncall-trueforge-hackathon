import { describe, expect, it } from 'vitest';

import {
  SPECIALIST_ROLES,
  correlateReports,
  validateSpecialistReport,
} from '../../agent/contracts.mjs';

const evidence = (tool: string) => [
  { tool, arguments: {}, observations: ['observed=true'] },
];

function reports() {
  return {
    'log-analyzer': {
      contract_version: '1.0',
      role: 'log-analyzer',
      status: 'complete',
      incident_id: 'INC-4821',
      service: 'checkout-svc',
      first_error_at: '2026-08-29T14:32:00Z',
      error_patterns: [
        {
          signature: 'request deadline exceeded',
          count: 12,
          sample_lines: ['verbatim'],
        },
      ],
      evidence: evidence('logs_query'),
      unknowns: [],
    },
    'metrics-analyzer': {
      contract_version: '1.0',
      role: 'metrics-analyzer',
      status: 'complete',
      incident_id: 'INC-4821',
      service: 'checkout-svc',
      baseline: { p50_ms: 35, p95_ms: 65, p99_ms: 80, error_rate_pct: 0.1 },
      first_anomaly_at: '2026-08-29T14:32:00Z',
      peak: { p50_ms: 1100, p95_ms: 4900, p99_ms: 6200, error_rate_pct: 12 },
      evidence: evidence('metrics_query'),
      unknowns: [],
    },
    'deploy-investigator': {
      contract_version: '1.0',
      role: 'deploy-investigator',
      status: 'complete',
      incident_id: 'INC-4821',
      service: 'checkout-svc',
      suspect_deploy: {
        id: '9921',
        deployed_at: '2026-08-29T14:30:00Z',
        commit: 'abc123def456',
        author: 'bob',
        message: 'perf: parallelize order lookup',
        files_changed: ['src/orders.py'],
      },
      evidence: evidence('deploy_get'),
      unknowns: [],
    },
    'code-blame': {
      contract_version: '1.0',
      role: 'code-blame',
      status: 'complete',
      incident_id: 'INC-4821',
      service: 'checkout-svc',
      deploy_id: '9921',
      commit: 'abc123def456',
      findings: [
        {
          file: 'src/orders.py',
          start_line: 142,
          end_line: 145,
          observed_code: '142: for item in items:',
          hypothesis:
            'one database round trip per item exceeds the request deadline',
          symptoms_explained: ['p99 latency', 'request deadline errors'],
        },
      ],
      evidence: evidence('code_get_file'),
      unknowns: [],
    },
  };
}

describe('specialist result contracts', () => {
  it('accepts all four complete reports and passes the 120-second correlation boundary', () => {
    const result = correlateReports(reports());
    expect(result).toEqual({
      ready: true,
      errors: [],
      correlations: {
        incident_id: 'INC-4821',
        service: 'checkout-svc',
        deploy_to_anomaly_seconds: 120,
        error_to_anomaly_seconds: 0,
        deploy_id: '9921',
        commit: 'abc123def456',
      },
    });
  });

  it.each(SPECIALIST_ROLES)(
    'rejects an insufficient %s report during fan-in',
    role => {
      const input = reports();
      const selected = input[role] as {
        status: string;
        unknowns: string[];
      };
      selected.status = 'insufficient';
      selected.unknowns = ['required evidence missing'];
      const result = correlateReports(input);
      expect(result.ready).toBe(false);
      expect(result.errors).toContain(`${role}: report is not complete`);
    },
  );

  it('rejects reports without provenance', () => {
    const report = reports()['log-analyzer'];
    report.evidence = [];
    const result = validateSpecialistReport(report, 'log-analyzer');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'evidence must contain at least one tool observation',
    );
  });

  it('blocks synthesis when deploy and anomaly differ by more than 120 seconds', () => {
    const input = reports();
    input['deploy-investigator'].suspect_deploy.deployed_at =
      '2026-08-29T14:29:59Z';
    const result = correlateReports(input);
    expect(result.ready).toBe(false);
    expect(result.errors).toContain(
      'suspect deploy is more than 120 seconds from the first metric anomaly',
    );
  });

  it('blocks synthesis when code is not from the suspect deploy', () => {
    const input = reports();
    input['code-blame'].commit = 'different-commit';
    const result = correlateReports(input);
    expect(result.ready).toBe(false);
    expect(result.errors).toContain(
      'code finding commit does not match suspect deploy',
    );
  });
});
