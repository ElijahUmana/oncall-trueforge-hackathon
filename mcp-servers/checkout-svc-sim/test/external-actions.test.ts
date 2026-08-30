import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScenarioStore } from '../src/scenario.js';
import { buildServer } from '../src/server.js';

async function connectedClient(
  store: ScenarioStore,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildServer(store);
  const client = new Client({
    name: 'external-actions-test',
    version: '1.0.0',
  });
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
  vi.unstubAllGlobals();
});

describe('external action tools', () => {
  it('uses Slack bot delivery first and returns verifiable message identifiers', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-auth');
    vi.stubEnv('SLACK_CHANNEL_ID', 'C0123456789');
    vi.stubEnv(
      'SLACK_WEBHOOK_URL',
      'https://hooks.slack.test/services/fallback',
    );
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          channel: 'C0123456789',
          ts: '1725000000.123456',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          permalink:
            'https://example.slack.com/archives/C0123456789/p1725000000123456',
        }),
      );
    vi.stubGlobal('fetch', provider);
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'Incident INC-4821 mitigated',
          actor: 'integration-test',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(provider).toHaveBeenCalledTimes(2);
      const [postUrl, postInit] = provider.mock.calls[0] ?? [];
      expect(postUrl).toBe('https://slack.com/api/chat.postMessage');
      expect(new Headers(postInit?.headers).get('authorization')).toBe(
        'Bearer fixture-bot-auth',
      );
      if (typeof postInit?.body !== 'string') {
        throw new Error('Expected Slack bot request body to be a JSON string');
      }
      expect(JSON.parse(postInit.body)).toEqual({
        channel: 'C0123456789',
        text: 'Incident INC-4821 mitigated',
        unfurl_links: false,
        unfurl_media: false,
        username: 'ONCALL',
        icon_emoji: ':rotating_light:',
      });
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          delivered: true,
          mode: 'bot',
          channel_id: 'C0123456789',
          message_ts: '1725000000.123456',
          permalink:
            'https://example.slack.com/archives/C0123456789/p1725000000123456',
        }),
      );
      expect(JSON.stringify(result)).not.toContain('fixture-bot-auth');
    } finally {
      await close();
    }
  });

  it('renders validated ONCALL Block Kit and preserves threaded delivery', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-auth');
    vi.stubEnv('SLACK_CHANNEL_ID', 'C0123456789');
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          channel: 'C0123456789',
          ts: '1725000001.123456',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          permalink:
            'https://example.slack.com/archives/C0123456789/p1725000001123456',
        }),
      );
    vi.stubGlobal('fetch', provider);
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'INC-4821 resolved. Error rate recovered from 12% to 0%.',
          actor: 'integration-test',
          presentation: {
            delivery: 'preview',
            severity: 'SEV-1',
            status: 'resolved',
            service: 'checkout-svc',
            deploy_id: '9921',
            commit_sha: 'b9c9167e17ed9e5a1159edcadedf1e5349550dbc',
            root_cause: 'Serial <per-item> writes caused p99 latency & 503s.',
            recovery: 'Reverted deploy 9921 and verified remote SHA.',
            permanent_fix: 'PR #1 remains open and unmerged.',
            pre_evidence: {
              requests: 25,
              errors: 3,
              error_rate: 0.12,
              p99_ms: 6946.5,
              health: 'degraded',
            },
            post_evidence: {
              requests: 25,
              errors: 0,
              error_rate: 0,
              p99_ms: 122.4,
              health: 'healthy',
            },
            links: {
              github: 'https://github.com/example/oncall',
              linear: 'https://linear.app/example/issue/ELI-6',
              operator: 'https://operator.example.test/incidents/INC-4821',
            },
            thread_ts: '1725000000.123456',
          },
        },
      });
      expect(result.isError).not.toBe(true);
      const [, postInit] = provider.mock.calls[0] ?? [];
      if (typeof postInit?.body !== 'string') {
        throw new Error('Expected Slack bot request body to be a JSON string');
      }
      const parsedBody: unknown = JSON.parse(postInit.body);
      if (
        parsedBody === null ||
        typeof parsedBody !== 'object' ||
        Array.isArray(parsedBody)
      ) {
        throw new Error('Expected Slack bot request body to be an object');
      }
      const body = parsedBody as Record<string, unknown>;
      expect(body).toMatchObject({
        channel: 'C0123456789',
        text: 'INC-4821 resolved. Error rate recovered from 12% to 0%.',
        unfurl_links: false,
        unfurl_media: false,
        username: 'ONCALL',
        icon_emoji: ':rotating_light:',
        thread_ts: '1725000000.123456',
      });
      const blocks = body.blocks;
      if (!Array.isArray(blocks)) {
        throw new Error('Expected Slack bot request body to contain blocks');
      }
      const serializedBlocks = JSON.stringify(blocks);
      expect(serializedBlocks).toContain(
        'PREVIEW · SEV-1 · INC-4821 · RESOLVED',
      );
      expect(serializedBlocks).toContain(
        'Serial &lt;per-item&gt; writes caused p99 latency &amp; 503s.',
      );
      expect(serializedBlocks).toContain('Production recovered');
      expect(serializedBlocks).toContain('Permanent guard under review');
      expect(serializedBlocks).toContain('PR #1 remains open and unmerged.');
      expect(serializedBlocks).toContain('"type":"actions"');
      expect(serializedBlocks).toContain('"type":"context"');
    } finally {
      await close();
    }
  });

  it('reports delivered bot message when permalink lookup fails', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-auth');
    vi.stubEnv('SLACK_CHANNEL_ID', 'C0123456789');
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          channel: 'C0123456789',
          ts: '1725000000.123456',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: false, error: 'missing_scope' }),
      );
    vi.stubGlobal('fetch', provider);
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'Incident INC-4821 mitigated',
          actor: 'integration-test',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          delivered: true,
          mode: 'bot',
          channel_id: 'C0123456789',
          message_ts: '1725000000.123456',
          permalink_error: 'Slack chat.getPermalink failed: missing_scope',
        }),
      );
      expect(store.listAudit('INC-4821').events).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('surfaces Slack ok:false without recording success', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-auth');
    vi.stubEnv('SLACK_CHANNEL_ID', 'C0123456789');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ ok: false, error: 'not_in_channel' }),
        ),
    );
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'Incident INC-4821 mitigated',
          actor: 'integration-test',
        },
      });
      expect(result.isError).toBe(true);
      expect(store.listAudit('INC-4821').events).toEqual([]);
    } finally {
      await close();
    }
  });

  it('requires channel ID when bot mode is configured', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'fixture-bot-auth');
    vi.stubEnv('SLACK_CHANNEL_ID', '');
    const provider = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', provider);
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'Incident INC-4821 mitigated',
          actor: 'integration-test',
        },
      });
      expect(result.isError).toBe(true);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('reports Slack webhook success only after an accepted provider response', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_CHANNEL_ID', '');
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.test/services/demo');
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', provider);
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'Incident INC-4821 mitigated',
          actor: 'integration-test',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(provider).toHaveBeenCalledOnce();
      const [url, init] = provider.mock.calls[0] ?? [];
      expect(url).toBe('https://hooks.slack.test/services/demo');
      if (typeof init?.body !== 'string') {
        throw new Error('Expected Slack request body to be a JSON string');
      }
      expect(JSON.parse(init.body)).toEqual({
        channel: '#oncall-demo',
        text: 'Incident INC-4821 mitigated',
        unfurl_links: false,
        unfurl_media: false,
      });
      expect(store.listAudit('INC-4821').events).toContainEqual(
        expect.objectContaining({
          action: 'slack.message_posted',
          details: {
            mode: 'webhook',
            requested_channel: '#oncall-demo',
            channel_id: '#oncall-demo',
            http_status: 200,
          },
        }),
      );
    } finally {
      await close();
    }
  });

  it('surfaces Slack provider rejection without recording success', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_CHANNEL_ID', '');
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.test/services/demo');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('invalid_payload', { status: 400 })),
    );
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'slack_post_message',
        arguments: {
          incident_id: 'INC-4821',
          channel: '#oncall-demo',
          text: 'Incident INC-4821 mitigated',
          actor: 'integration-test',
        },
      });
      expect(result.isError).toBe(true);
      expect(store.listAudit('INC-4821').events).toEqual([]);
    } finally {
      await close();
    }
  });

  it('returns verifiable Jira identifiers only after a valid success response', async () => {
    vi.stubEnv('JIRA_BASE_URL', 'https://jira.example.test');
    vi.stubEnv('JIRA_EMAIL', 'oncall@example.test');
    vi.stubEnv('JIRA_API_TOKEN', 'test-token');
    vi.stubEnv('JIRA_PROJECT_KEY', 'OPS');
    const provider = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          id: '10042',
          key: 'OPS-42',
          self: 'https://jira.example.test/rest/api/3/issue/10042',
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', provider);
    const store = new ScenarioStore();
    const { client, close } = await connectedClient(store);

    try {
      const result = await client.callTool({
        name: 'jira_create_issue',
        arguments: {
          incident_id: 'INC-4821',
          summary: 'Prevent per-item checkout database writes',
          description:
            'Add regression coverage for large-cart request deadlines.',
          actor: 'integration-test',
        },
      });
      expect(result.isError).not.toBe(true);
      const [, init] = provider.mock.calls[0] ?? [];
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Basic ${Buffer.from('oncall@example.test:test-token').toString('base64')}`,
      );
      expect(store.listAudit('INC-4821').events).toContainEqual(
        expect.objectContaining({
          action: 'jira.issue_created',
          details: {
            issue_id: '10042',
            issue_key: 'OPS-42',
            issue_url: 'https://jira.example.test/rest/api/3/issue/10042',
          },
        }),
      );
    } finally {
      await close();
    }
  });
});
