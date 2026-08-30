import { describe, expect, it } from 'vitest';
import { ingestEvents } from '../src/telemetry-ingest';
import { createTelemetryStore } from '../src/telemetry-store';

const workerReports = [
  {
    title: 'log-analyzer',
    thread_id: 'thread-log',
    output: {
      contract_version: '1.0',
      role: 'log-analyzer',
      status: 'complete',
      evidence: [
        {
          tool: 'logs_query',
          observations: ['first_error_at=2026-08-29T14:32:01Z'],
        },
      ],
    },
  },
  {
    title: 'metrics-analyzer',
    thread_id: 'thread-metrics',
    output: {
      contract_version: '1.0',
      role: 'metrics-analyzer',
      status: 'complete',
      evidence: [
        { tool: 'metrics_query', observations: ['peak_p99_ms=6813.7'] },
      ],
    },
  },
  {
    title: 'deploy-investigator',
    thread_id: 'thread-deploy',
    output: {
      contract_version: '1.0',
      role: 'deploy-investigator',
      status: 'complete',
      evidence: [{ tool: 'deploy_get', observations: ['deploy.id=9921'] }],
    },
  },
  {
    title: 'code-blame',
    thread_id: 'thread-code',
    output: {
      contract_version: '1.0',
      role: 'code-blame',
      status: 'complete',
      evidence: [
        {
          tool: 'code_get_file',
          observations: ['path=checkout_service/orders.py'],
        },
      ],
    },
  },
] as const;

function workerEvents() {
  return workerReports.flatMap((worker, index) => [
    {
      type: 'thread.created',
      thread_id: worker.thread_id,
      title: worker.title,
      created_at: `2026-08-29T21:24:${40 + index}.000Z`,
    },
    {
      type: 'thread.done',
      thread_id: worker.thread_id,
      title: worker.title,
      created_at: `2026-08-29T21:25:${10 + index}.000Z`,
      state: {
        status: 'done',
        output: { content: JSON.stringify(worker.output) },
      },
    },
  ]);
}

function canonicalToolCall(
  id: string,
  name: string,
  serverName: string,
  input: Record<string, unknown> = {},
) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(input) },
    tool_info: {
      type: 'mcp',
      name,
      server_name: serverName,
    },
  };
}

describe('authoritative telemetry event ingestion', () => {
  it('replays four completed typed reports with evidence ready for correlation', () => {
    const store = createTelemetryStore();

    ingestEvents(workerEvents().reverse(), store);

    const state = store.getSnapshot();
    expect(
      Object.values(state.workers).every(x => x.status === 'success'),
    ).toBe(true);
    expect(Object.values(state.workers).every(x => x.evidenceCount > 0)).toBe(
      true,
    );
    expect(state.workers['log-analyzer'].evidenceSnippet).toContain(
      'first_error_at',
    );
    expect(state.fanIn).toBe('ready');
    expect(state.phase).toBe('correlating');
  });

  it('blocks fan-in when a typed report is insufficient', () => {
    const events = workerEvents();
    const insufficient = events.find(
      event => event.type === 'thread.done' && event.title === 'code-blame',
    );
    if (insufficient?.state?.output) {
      insufficient.state.output.content = JSON.stringify({
        status: 'insufficient',
        evidence: [],
        unknowns: ['source file unavailable'],
      });
    }
    const store = createTelemetryStore();

    ingestEvents(events, store);

    expect(store.getSnapshot().workers['code-blame'].status).toBe('error');
    expect(store.getSnapshot().fanIn).toBe('blocked');
    expect(store.getSnapshot().phase).toBe('failed');
  });

  it('resolves historical approval and question pauses from later user turns', () => {
    const store = createTelemetryStore();
    ingestEvents(
      [
        {
          type: 'model.message',
          created_at: '2026-08-29T20:59:59Z',
          tool_calls: [
            canonicalToolCall(
              'rollback-1',
              'rollback_execute',
              'checkout-svc-sim',
              { incident_id: 'INC-4821' },
            ),
          ],
        },
        {
          type: 'tool.approval_required',
          id: 'approval-1',
          created_at: '2026-08-29T21:00:00Z',
          tool_calls: [{ id: 'rollback-1' }],
        },
        {
          type: 'tool.response_required',
          created_at: '2026-08-29T21:00:01Z',
        },
        {
          type: 'turn.created',
          created_at: '2026-08-29T21:00:02Z',
          input: [
            {
              type: 'user.tool_response',
              tool_call_id: 'choice-1',
              content: 'rollback',
            },
          ],
        },
        {
          type: 'turn.created',
          created_at: '2026-08-29T21:00:03Z',
          input: [
            {
              type: 'user.tool_approval',
              tool_call_id: 'rollback-1',
              approval: { status: 'allow' },
            },
          ],
        },
      ],
      store,
    );

    expect(store.getSnapshot().choice).toBe('answered');
    expect(store.getSnapshot().approval).toMatchObject({
      toolCallId: 'rollback-1',
      toolName: 'rollback_execute',
      status: 'allowed',
      completedAt: '2026-08-29T21:00:03Z',
    });
    expect(store.getSnapshot().approvals).toHaveLength(1);
  });

  it('ingests complete authoritative incident, rollback, and closeout responses', () => {
    const store = createTelemetryStore();
    const events = [
      {
        type: 'model.message',
        thread_id: 'main',
        created_at: '2026-08-29T21:00:00Z',
        tool_calls: [
          canonicalToolCall(
            'incident-1',
            'pagerduty_get_incident',
            'checkout-svc-sim',
          ),
          canonicalToolCall(
            'rollback-1',
            'rollback_execute',
            'checkout-svc-sim',
          ),
          canonicalToolCall(
            'slack-1',
            'slack_post_message',
            'checkout-svc-sim',
          ),
          canonicalToolCall('linear-1', 'save_issue', 'linear'),
          canonicalToolCall(
            'pagerduty-1',
            'pagerduty_resolve',
            'checkout-svc-sim',
          ),
        ],
      },
      {
        type: 'tool.response',
        created_at: '2026-08-29T21:00:01Z',
        tool_call_id: 'incident-1',
        content: JSON.stringify({
          incident: {
            id: 'INC-4821',
            service: 'checkout-svc',
            severity: 'high',
            status: 'triggered',
            symptoms: { peak_p99_ms: 6813.7, peak_error_rate_pct: 12 },
          },
        }),
      },
      {
        type: 'tool.response',
        created_at: '2026-08-29T21:00:02Z',
        tool_call_id: 'rollback-1',
        content: JSON.stringify({
          repository_url: 'https://github.com/example/service.git',
          branch: 'main',
          sandbox_id: 'daytona-1',
          pre_evidence: {
            requests: 25,
            errors: 3,
            error_rate: 0.12,
            p99_ms: 6946.5,
          },
          revert_sha: '0681dd9e',
          tests_passed: true,
          post_evidence: {
            requests: 25,
            errors: 0,
            error_rate: 0,
            p99_ms: 122.4,
          },
          remote_sha: '0681dd9e',
          sandbox_stopped: true,
        }),
      },
      {
        type: 'tool.response',
        created_at: '2026-08-29T21:00:03Z',
        tool_call_id: 'slack-1',
        content: JSON.stringify({
          delivered: true,
          permalink: 'https://slack.test/rca',
        }),
      },
      {
        type: 'tool.response',
        created_at: '2026-08-29T21:00:04Z',
        tool_call_id: 'linear-1',
        content: JSON.stringify({ id: 'ELI-6' }),
      },
      {
        type: 'tool.response',
        created_at: '2026-08-29T21:00:05Z',
        tool_call_id: 'pagerduty-1',
        content: JSON.stringify({
          incident: { id: 'INC-4821', status: 'resolved' },
        }),
      },
    ];

    ingestEvents(events.reverse(), store);

    expect(store.getSnapshot()).toMatchObject({
      incident: {
        id: 'INC-4821',
        service: 'checkout-svc',
        peakP99Ms: 6813.7,
        peakErrorRatePct: 12,
        status: 'resolved',
      },
      recovery: {
        repositoryUrl: 'https://github.com/example/service.git',
        branch: 'main',
        revertSha: '0681dd9e',
        remoteSha: '0681dd9e',
        testsPassed: true,
        sandboxStopped: true,
      },
      sandbox: {
        status: 'success',
        name: 'daytona-1',
        exitCode: 0,
        resultSummary: '25 requests · 0 errors · p99 122.4ms',
      },
      closeout: {
        slack: { status: 'success', reference: 'https://slack.test/rca' },
        linear: { status: 'success', reference: 'ELI-6' },
        pagerduty: { status: 'success', reference: 'INC-4821' },
      },
      phase: 'resolved',
    });
  });

  it('does not infer facts from contradictory assistant prose', () => {
    const store = createTelemetryStore();
    ingestEvents(
      [
        {
          type: 'model.message',
          content:
            'The approval gate was not presented. Production is healthy and resolved.',
          thread_id: 'main',
        },
      ],
      store,
    );
    expect(store.getSnapshot()).toMatchObject({
      phase: 'standby',
      incident: {},
      recovery: {},
      sandbox: { status: 'idle' },
    });
  });

  it('marks truncated/unparseable responses unavailable, never successful', () => {
    const store = createTelemetryStore();
    ingestEvents(
      [
        {
          type: 'model.message',
          created_at: '2026-08-29T21:00:00Z',
          thread_id: 'main',
          tool_calls: [
            {
              id: 'call-1',
              name: 'call_tool',
              args: JSON.stringify({
                mcp_server: 'checkout-svc-sim',
                tool_name: 'rollback_execute',
              }),
            },
          ],
        },
        {
          type: 'tool.response',
          created_at: '2026-08-29T21:00:01Z',
          thread_id: 'main',
          tool_call_id: 'call-1',
          content: '{"revert_sha":"truncated',
        },
      ],
      store,
    );
    expect(store.getSnapshot().sandbox).toEqual({ status: 'idle' });
    expect(store.getSnapshot().tools['call-1']).toMatchObject({
      status: 'unavailable',
    });
    expect(store.getSnapshot().tools['call-1']).not.toHaveProperty(
      'evidenceSnippet',
    );
  });
});
