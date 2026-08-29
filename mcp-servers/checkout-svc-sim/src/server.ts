import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  ROLLBACK_BRANCH,
  ROLLBACK_REPOSITORY_URL,
  rollbackExecutor,
  type RollbackExecutor,
} from './rollback-executor.js';
import { scenarioStore, type ScenarioStore } from './scenario.js';

const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine(
    value => value.endsWith('Z'),
    'timestamp must be normalized UTC ending in Z',
  );
const incidentId = z.string().regex(/^INC-[0-9]+$/);
const serviceName = z.string().min(1).max(100);
const actor = z.string().trim().min(1).max(100);
const metricName = z.enum([
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'error_rate_pct',
  'db_round_trips_p99',
]);
const incidentSchema = z.object({
  id: incidentId,
  service: serviceName,
  severity: z.string(),
  summary: z.string(),
  started_at: timestamp,
  alerted_at: timestamp,
  status: z.enum(['triggered', 'acknowledged', 'resolved']),
  symptoms: z.record(z.string(), z.number()),
});
const deploySchema = z.object({
  id: z.string(),
  service: serviceName,
  deployed_at: timestamp,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  author: z.string(),
  message: z.string(),
  files_changed: z.array(z.string()),
  health: z.string(),
});
const auditEventSchema = z.object({
  sequence: z.number().int().positive(),
  timestamp,
  action: z.string(),
  actor: z.string(),
  incident_id: incidentId,
  details: z.record(z.string(), z.unknown()),
});
const rollbackEvidenceSchema = z.object({
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  error_rate: z.number().min(0).max(1),
  p99_ms: z.number().nonnegative(),
  health: z.string(),
});

function toolResult<T extends Record<string, unknown>>(structuredContent: T) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${operation} failed: ${message}`, { cause: error });
  }
}

function requireHttpsUrl(value: string, variable: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variable} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${variable} must use HTTPS`);
  }
  return parsed;
}

async function parseSlackResponse(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${operation} rejected with HTTP ${response.status}: ${body.slice(0, 1000)}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new Error(`${operation} returned a non-JSON response`, {
      cause: error,
    });
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new Error(`${operation} returned a non-object response`);
  }
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) {
    const slackError =
      typeof record.error === 'string' ? record.error : 'unknown_error';
    throw new Error(`${operation} failed: ${slackError}`);
  }
  return record;
}

function requireSlackString(
  value: unknown,
  field: string,
  operation: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${operation} response omitted ${field}`);
  }
  return value;
}

export function buildServer(
  store: ScenarioStore = scenarioStore,
  executor: RollbackExecutor = rollbackExecutor,
): McpServer {
  const server = new McpServer(
    { name: 'checkout-svc-sim', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    'pagerduty_get_incident',
    {
      description:
        'Get the current authoritative state and symptoms of a simulated PagerDuty incident.',
      inputSchema: z.object({ incident_id: incidentId }),
      outputSchema: z.object({ incident: incidentSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ incident_id }) =>
      toolResult({ incident: store.getIncident(incident_id) }),
  );

  server.registerTool(
    'pagerduty_acknowledge',
    {
      description:
        'Transition a triggered incident to acknowledged and append an audit event.',
      inputSchema: z.object({ incident_id: incidentId, actor }),
      outputSchema: z.object({
        incident: incidentSchema,
        audit_event: auditEventSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ incident_id, actor: acknowledgedBy }) =>
      toolResult(store.acknowledge(incident_id, acknowledgedBy)),
  );

  server.registerTool(
    'pagerduty_resolve',
    {
      description:
        'Transition an acknowledged incident to resolved with a concrete resolution and append an audit event.',
      inputSchema: z.object({
        incident_id: incidentId,
        actor,
        resolution: z.string().trim().min(10).max(2000),
      }),
      outputSchema: z.object({
        incident: incidentSchema,
        audit_event: auditEventSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ incident_id, actor: resolvedBy, resolution }) =>
      toolResult(store.resolve(incident_id, resolvedBy, resolution)),
  );

  server.registerTool(
    'logs_query',
    {
      description:
        'Query deterministic checkout service logs in an inclusive UTC time range.',
      inputSchema: z
        .object({
          service: serviceName,
          start: timestamp,
          end: timestamp,
          level: z.enum(['INFO', 'WARN', 'ERROR']).optional(),
          contains: z.string().trim().min(1).max(200).optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .refine(({ start, end }) => start <= end, {
          message: 'start must be at or before end',
          path: ['end'],
        }),
      outputSchema: z.object({
        service: serviceName,
        start: timestamp,
        end: timestamp,
        count: z.number().int().nonnegative(),
        truncated: z.boolean(),
        lines: z.array(z.string()),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ service, start, end, level, contains, limit }) =>
      toolResult(store.queryLogs(service, start, end, level, contains, limit)),
  );

  server.registerTool(
    'metrics_query',
    {
      description:
        'Query deterministic checkout latency, error-rate, and database-pool metrics in an inclusive UTC range.',
      inputSchema: z
        .object({
          service: serviceName,
          start: timestamp,
          end: timestamp,
          metrics: z
            .array(metricName)
            .min(1)
            .max(5)
            .refine(
              names => new Set(names).size === names.length,
              'metrics must be unique',
            ),
        })
        .refine(({ start, end }) => start <= end, {
          message: 'start must be at or before end',
          path: ['end'],
        }),
      outputSchema: z.object({
        service: serviceName,
        start: timestamp,
        end: timestamp,
        metrics: z.array(metricName),
        points: z.array(
          z.record(z.string(), z.union([z.string(), z.number()])),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ service, start, end, metrics }) =>
      toolResult(store.queryMetrics(service, start, end, metrics)),
  );

  server.registerTool(
    'deploys_list',
    {
      description:
        'List checkout service deploys in an inclusive UTC range, newest first.',
      inputSchema: z
        .object({
          service: serviceName,
          start: timestamp,
          end: timestamp,
          limit: z.number().int().min(1).max(100).default(20),
        })
        .refine(({ start, end }) => start <= end, {
          message: 'start must be at or before end',
          path: ['end'],
        }),
      outputSchema: z.object({
        service: serviceName,
        deploys: z.array(deploySchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ service, start, end, limit }) =>
      toolResult(store.listDeploys(service, start, end, limit)),
  );

  server.registerTool(
    'deploy_get',
    {
      description: 'Get an authoritative checkout deployment record by ID.',
      inputSchema: z.object({ deploy_id: z.string().regex(/^[0-9]+$/) }),
      outputSchema: z.object({ deploy: deploySchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ deploy_id }) => toolResult({ deploy: store.getDeploy(deploy_id) }),
  );

  server.registerTool(
    'code_get_file',
    {
      description:
        'Read an allowlisted checkout service source file with stable line numbers.',
      inputSchema: z
        .object({
          path: z.enum(['checkout_service/orders.py']),
          start_line: z.number().int().min(1).default(1),
          end_line: z.number().int().min(1).optional(),
        })
        .refine(
          ({ start_line, end_line }) =>
            end_line === undefined || start_line <= end_line,
          {
            message: 'start_line must be at or before end_line',
            path: ['end_line'],
          },
        ),
      outputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().positive(),
        end_line: z.number().int().positive(),
        total_lines: z.number().int().positive(),
        content: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ path, start_line, end_line }) =>
      toolResult(store.getSourceFile(path, start_line, end_line)),
  );

  server.registerTool(
    'rollback_execute',
    {
      description:
        'Execute an approved rollback in an isolated Daytona sandbox, push the revert to main, and verify pre/post service evidence plus the remote SHA.',
      inputSchema: z.object({
        incident_id: incidentId,
        deploy_id: z.string().regex(/^[0-9]+$/),
        repository_url: z.literal(ROLLBACK_REPOSITORY_URL),
        branch: z.literal(ROLLBACK_BRANCH),
        requested_by: actor,
        reason: z.string().trim().min(10).max(2000),
      }),
      outputSchema: z.object({
        incident_id: incidentId,
        deploy_id: z.string(),
        repository_url: z.string().url(),
        branch: z.string(),
        sandbox_id: z.string(),
        pre_evidence: rollbackEvidenceSchema,
        revert_sha: z.string().regex(/^[0-9a-f]{40}$/),
        post_evidence: rollbackEvidenceSchema,
        remote_sha: z.string().regex(/^[0-9a-f]{40}$/),
        tests_passed: z.literal(true),
        sandbox_stopped: z.boolean(),
        cleanup_error: z.string().optional(),
        audit_event: auditEventSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      incident_id,
      deploy_id,
      repository_url,
      branch,
      requested_by,
      reason,
    }) => {
      const incident = store.getIncident(incident_id);
      if (incident.status !== 'acknowledged') {
        throw new Error(
          `Rollback execution requires acknowledged incident; ${incident_id} is ${incident.status}`,
        );
      }
      const deploy = store.getDeploy(deploy_id);
      const execution = await executor.execute({
        deployId: deploy.id,
        deployCommit: deploy.commit,
        repositoryUrl: repository_url,
        branch,
      });
      const auditEvent = store.recordExternalAction(
        'remediation.rollback_executed',
        requested_by,
        {
          deploy_id,
          repository_url: execution.repository_url,
          branch,
          reason,
          sandbox_id: execution.sandbox_id,
          revert_sha: execution.revert_sha,
          remote_sha: execution.remote_sha,
          pre_evidence: execution.pre_evidence,
          post_evidence: execution.post_evidence,
        },
      );
      return toolResult({
        incident_id,
        deploy_id,
        ...execution,
        audit_event: auditEvent,
      });
    },
  );

  server.registerTool(
    'audit_list',
    {
      description:
        'List ordered state-transition and external-action audit records for an incident.',
      inputSchema: z.object({
        incident_id: incidentId,
        after_sequence: z.number().int().min(0).default(0),
      }),
      outputSchema: z.object({
        incident_id: incidentId,
        events: z.array(auditEventSchema),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ incident_id, after_sequence }) =>
      toolResult(store.listAudit(incident_id, after_sequence)),
  );

  server.registerTool(
    'slack_post_message',
    {
      description:
        'Post a real Slack message using SLACK_BOT_TOKEN and SLACK_CHANNEL_ID, or fall back to SLACK_WEBHOOK_URL when bot credentials are absent.',
      inputSchema: z.object({
        incident_id: incidentId,
        channel: z.string().trim().min(1).max(100),
        text: z.string().trim().min(1).max(4000),
        actor,
      }),
      outputSchema: z.object({
        delivered: z.literal(true),
        mode: z.enum(['bot', 'webhook']),
        channel_id: z.string(),
        message_ts: z.string().optional(),
        permalink: z.string().url().optional(),
        permalink_error: z.string().optional(),
        http_status: z.number().int(),
        audit_event: auditEventSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ incident_id, channel, text, actor: postedBy }) => {
      store.getIncident(incident_id);
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (botToken !== undefined && botToken.length > 0) {
        const channelId = process.env.SLACK_CHANNEL_ID;
        if (channelId === undefined || channelId.length === 0) {
          throw new Error(
            'Slack bot delivery unavailable: SLACK_CHANNEL_ID is not configured',
          );
        }
        const postResponse = await fetchWithTimeout(
          'https://slack.com/api/chat.postMessage',
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${botToken}`,
              'content-type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ channel: channelId, text }),
          },
          'Slack chat.postMessage',
        );
        const postPayload = await parseSlackResponse(
          postResponse,
          'Slack chat.postMessage',
        );
        const responseChannel = requireSlackString(
          postPayload.channel,
          'channel',
          'Slack chat.postMessage',
        );
        const messageTs = requireSlackString(
          postPayload.ts,
          'ts',
          'Slack chat.postMessage',
        );
        let permalink: string | undefined;
        let permalinkError: string | undefined;
        try {
          const permalinkResponse = await fetchWithTimeout(
            `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(responseChannel)}&message_ts=${encodeURIComponent(messageTs)}`,
            {
              method: 'GET',
              headers: { authorization: `Bearer ${botToken}` },
            },
            'Slack chat.getPermalink',
          );
          const permalinkPayload = await parseSlackResponse(
            permalinkResponse,
            'Slack chat.getPermalink',
          );
          if (typeof permalinkPayload.permalink === 'string') {
            permalink = permalinkPayload.permalink;
          }
        } catch (error) {
          permalinkError =
            error instanceof Error
              ? error.message
              : 'Slack chat.getPermalink failed with a non-Error value';
        }
        const auditEvent = store.recordExternalAction(
          'slack.message_posted',
          postedBy,
          {
            mode: 'bot',
            requested_channel: channel,
            channel_id: responseChannel,
            message_ts: messageTs,
            ...(permalink !== undefined && { permalink }),
            ...(permalinkError !== undefined && {
              permalink_error: permalinkError,
            }),
          },
        );
        return toolResult({
          delivered: true,
          mode: 'bot' as const,
          channel_id: responseChannel,
          message_ts: messageTs,
          ...(permalink !== undefined && { permalink }),
          ...(permalinkError !== undefined && {
            permalink_error: permalinkError,
          }),
          http_status: postResponse.status,
          audit_event: auditEvent,
        });
      }

      const webhook = process.env.SLACK_WEBHOOK_URL;
      if (webhook === undefined || webhook.length === 0) {
        throw new Error(
          'Slack delivery unavailable: configure SLACK_BOT_TOKEN and SLACK_CHANNEL_ID, or SLACK_WEBHOOK_URL',
        );
      }
      const url = requireHttpsUrl(webhook, 'SLACK_WEBHOOK_URL');
      const response = await fetchWithTimeout(
        url.href,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel, text }),
        },
        'Slack webhook delivery',
      );
      const providerResponse = await response.text();
      if (!response.ok || providerResponse.trim() !== 'ok') {
        throw new Error(
          `Slack webhook delivery rejected with HTTP ${response.status}: ${providerResponse.slice(0, 500)}`,
        );
      }
      const auditEvent = store.recordExternalAction(
        'slack.message_posted',
        postedBy,
        {
          mode: 'webhook',
          requested_channel: channel,
          channel_id: channel,
          http_status: response.status,
        },
      );
      return toolResult({
        delivered: true,
        mode: 'webhook' as const,
        channel_id: channel,
        http_status: response.status,
        audit_event: auditEvent,
      });
    },
  );

  server.registerTool(
    'jira_create_issue',
    {
      description:
        'Create a real Jira Cloud issue. Fails visibly when credentials are absent or Jira rejects the request.',
      inputSchema: z.object({
        incident_id: incidentId,
        summary: z.string().trim().min(1).max(255),
        description: z.string().trim().min(1).max(10000),
        issue_type: z.string().trim().min(1).max(100).default('Task'),
        actor,
      }),
      outputSchema: z.object({
        created: z.literal(true),
        id: z.string(),
        key: z.string(),
        self: z.string().url(),
        audit_event: auditEventSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      incident_id,
      summary,
      description,
      issue_type,
      actor: createdBy,
    }) => {
      store.getIncident(incident_id);
      const baseUrl = process.env.JIRA_BASE_URL;
      const email = process.env.JIRA_EMAIL;
      const token = process.env.JIRA_API_TOKEN;
      const projectKey = process.env.JIRA_PROJECT_KEY;
      const missing = [
        ['JIRA_BASE_URL', baseUrl],
        ['JIRA_EMAIL', email],
        ['JIRA_API_TOKEN', token],
        ['JIRA_PROJECT_KEY', projectKey],
      ]
        .filter(([, value]) => value === undefined || value.length === 0)
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(
          `Jira delivery unavailable: missing ${missing.join(', ')}`,
        );
      }
      const jiraUrl = requireHttpsUrl(baseUrl!, 'JIRA_BASE_URL');
      const endpoint = new URL('/rest/api/3/issue', jiraUrl);
      const response = await fetchWithTimeout(
        endpoint.href,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${email!}:${token!}`).toString('base64')}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            fields: {
              project: { key: projectKey },
              summary,
              issuetype: { name: issue_type },
              description: {
                type: 'doc',
                version: 1,
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: description }],
                  },
                ],
              },
            },
          }),
        },
        'Jira issue creation',
      );
      const providerResponse = await response.text();
      if (!response.ok) {
        throw new Error(
          `Jira issue creation rejected with HTTP ${response.status}: ${providerResponse.slice(0, 1000)}`,
        );
      }
      let created: { id?: unknown; key?: unknown; self?: unknown };
      try {
        created = JSON.parse(providerResponse) as {
          id?: unknown;
          key?: unknown;
          self?: unknown;
        };
      } catch {
        throw new Error(
          'Jira issue creation returned a non-JSON success response',
        );
      }
      if (
        typeof created.id !== 'string' ||
        typeof created.key !== 'string' ||
        typeof created.self !== 'string'
      ) {
        throw new Error(
          'Jira issue creation response omitted id, key, or self',
        );
      }
      const auditEvent = store.recordExternalAction(
        'jira.issue_created',
        createdBy,
        {
          issue_id: created.id,
          issue_key: created.key,
          issue_url: created.self,
        },
      );
      return toolResult({
        created: true,
        id: created.id,
        key: created.key,
        self: created.self,
        audit_event: auditEvent,
      });
    },
  );

  return server;
}
