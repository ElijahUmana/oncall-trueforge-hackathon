import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const DEFAULT_INCIDENT_ID = 'INC-4821';
const DEFAULT_AGENT_NAME = 'oncall-incident-responder';
const DEFAULT_STATE_PATH = resolve(
  process.env.HOME ?? '.',
  'Library/Application Support/ONCALL TrueForge/demo-control.json',
);

type DemoPhase =
  | 'healthy'
  | 'detected'
  | 'investigating'
  | 'decision'
  | 'approval'
  | 'executing'
  | 'recovered'
  | 'failed';

type DemoCheckpoint = {
  kind: 'response' | 'approval';
  toolCallId: string;
  threadId: string;
  title: string;
  detail: string;
  options: string[];
};

type DemoState = {
  phase: DemoPhase;
  incidentId: string;
  sessionId?: string;
  detectedAt?: string;
  slackStatus?: 'pending' | 'delivered' | 'failed';
  slackPermalink?: string;
  checkpoint?: DemoCheckpoint;
  notifiedCheckpointId?: string;
  message?: string;
  demoOverride?: boolean;
  executionStep?: number;
  executionStartedAt?: string;
  recovery?: {
    sandboxId: string;
    preP99Ms: number;
    preErrors: number;
    postP99Ms: number;
    postErrors: number;
    revertSha: string;
    remoteSha: string;
    testsPassed: boolean;
    sandboxStopped: boolean;
    githubUrl: string;
    linearUrl: string;
  };
  finalSlackPermalink?: string;
  nonce: string;
};

type DemoEnvironment = {
  TRUEFORGE_BASE_URL?: string;
  TRUEFORGE_TOKEN?: string;
  ONCALL_AGENT_NAME?: string;
  ONCALL_OPERATOR_URL?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
  DEMO_STATE_PATH?: string;
};

function initialState(): DemoState {
  return {
    phase: 'healthy',
    incidentId: DEFAULT_INCIDENT_ID,
    nonce: randomUUID(),
  };
}

async function readState(path: string): Promise<DemoState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DemoState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialState();
    throw error;
  }
}

async function saveState(path: string, state: DemoState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function trueForgeRequest(
  environment: DemoEnvironment,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const baseUrl = environment.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      ...authHeaders(environment.TRUEFORGE_TOKEN),
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `TrueForge ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function sessionId(payload: Record<string, unknown>): string {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) {
    throw new Error('TrueForge session response is missing data');
  }
  const id = (data as Record<string, unknown>).id;
  if (typeof id !== 'string') {
    throw new Error('TrueForge session response is missing data.id');
  }
  return id;
}

async function slackPermalink(
  token: string,
  channel: string,
  timestamp: string,
): Promise<string | undefined> {
  const response = await fetch(
    `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(timestamp)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const payload = (await response.json()) as {
    ok?: boolean;
    permalink?: string;
  };
  return payload.ok ? payload.permalink : undefined;
}

async function postInvestigationStarted(
  environment: DemoEnvironment,
  incidentId: string,
  session: string,
): Promise<string | undefined> {
  const token = environment.SLACK_BOT_TOKEN;
  const channel = environment.SLACK_CHANNEL_ID;
  if (!token || !channel) return undefined;
  const operator = environment.ONCALL_OPERATOR_URL ?? 'http://127.0.0.1:4334';
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      username: 'ONCALL',
      icon_emoji: ':rotating_light:',
      unfurl_links: false,
      unfurl_media: false,
      text: `${incidentId}: ONCALL investigation started`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `ONCALL is investigating ${incidentId}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*checkout-svc* crossed the production latency and error thresholds. Four TrueForge specialists are collecting logs, metrics, deploy, and code evidence in parallel.',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: ':large_green_circle: Investigation live · human approval required before production mutation',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Watch live investigation' },
              url: `${operator}/sessions/${encodeURIComponent(session)}`,
              style: 'primary',
            },
          ],
        },
      ],
    }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    error?: string;
    ts?: string;
  };
  if (!payload.ok || !payload.ts) {
    throw new Error(`Slack investigation message failed: ${payload.error ?? 'unknown error'}`);
  }
  return slackPermalink(token, channel, payload.ts);
}

function actionSignature(state: DemoState, value: string): string {
  const checkpoint = state.checkpoint;
  if (!checkpoint) return '';
  return createHash('sha256')
    .update(`${state.nonce}:${checkpoint.kind}:${checkpoint.toolCallId}:${value}`)
    .digest('hex');
}

async function sessionEvents(
  environment: DemoEnvironment,
  sessionId: string,
): Promise<Record<string, unknown>[]> {
  const payload = await trueForgeRequest(
    environment,
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    { method: 'GET' },
  );
  return Array.isArray(payload.data)
    ? payload.data.map(row => {
        const record = row as Record<string, unknown>;
        return (record.event as Record<string, unknown> | undefined) ?? record;
      })
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function pendingCheckpoint(events: Record<string, unknown>[]): DemoCheckpoint | undefined {
  const answered = new Set<string>();
  for (const event of events) {
    if (event.type !== 'turn.created' || !Array.isArray(event.input)) continue;
    for (const raw of event.input) {
      const input = record(raw);
      if (
        (input?.type === 'user.tool_response' ||
          input?.type === 'user.tool_approval') &&
        typeof input.tool_call_id === 'string'
      ) {
        answered.add(input.tool_call_id);
      }
    }
  }
  const ordered = [...events].sort((left, right) =>
    String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')),
  );
  for (const event of ordered) {
    if (
      event.type !== 'tool.response_required' &&
      event.type !== 'tool.approval_required'
    ) {
      continue;
    }
    const call = Array.isArray(event.tool_calls)
      ? record(event.tool_calls[0])
      : undefined;
    const toolCallId =
      typeof call?.id === 'string' ? call.id : undefined;
    if (!toolCallId || answered.has(toolCallId)) continue;
    const source = ordered.find(candidate => candidate.id === call?.source_event_id);
    const sourceCalls = Array.isArray(source?.tool_calls) ? source.tool_calls : [];
    const sourceCall = record(sourceCalls.find(raw => record(raw)?.id === toolCallId));
    const fn = record(sourceCall?.function);
    let args: Record<string, unknown> = {};
    if (typeof fn?.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    if (event.type === 'tool.response_required') {
      const options = Array.isArray(args.options)
        ? args.options.filter((value): value is string => typeof value === 'string')
        : ['rollback the suspect deploy', 'escalate without action'];
      return {
        kind: 'response',
        toolCallId,
        threadId: typeof event.thread_id === 'string' ? event.thread_id : 'main',
        title:
          typeof args.question === 'string'
            ? args.question
            : 'Select a remediation path',
        detail: 'Your choice resumes the same persisted TrueForge session.',
        options,
      };
    }
    const outerName = typeof fn?.name === 'string' ? fn.name : 'production operation';
    let toolName = outerName;
    let detail = 'TrueForge is paused. The operation cannot continue without this decision.';
    if (outerName === 'call_tool') {
      const nestedName = typeof args.tool_name === 'string' ? args.tool_name : undefined;
      const nestedInput = record(args.input);
      if (nestedName) toolName = nestedName;
      if (nestedName === 'slack_post_message') {
        detail = 'Post the correlated RCA and remediation choices to Slack #oncall-demo. This is not rollback approval.';
      } else if (nestedName === 'rollback_execute') {
        const deployId = typeof nestedInput?.deploy_id === 'string' ? nestedInput.deploy_id : '9921';
        const repository = typeof nestedInput?.repository_url === 'string' ? nestedInput.repository_url : 'oncall-demo-svc';
        const branch = typeof nestedInput?.branch === 'string' ? nestedInput.branch : 'main';
        detail = `Revert deploy ${deployId} in ${repository} on ${branch}, run tests, push, verify remote recovery, and stop the Daytona sandbox.`;
      }
    }
    return {
      kind: 'approval',
      toolCallId,
      threadId: typeof event.thread_id === 'string' ? event.thread_id : 'main',
      title: `Approve ${toolName.replaceAll('_', ' ')}?`,
      detail,
      options: ['allow', 'deny'],
    };
  }
  return undefined;
}

async function postCheckpoint(
  environment: DemoEnvironment,
  state: DemoState,
): Promise<string | undefined> {
  const token = environment.SLACK_BOT_TOKEN;
  const channel = environment.SLACK_CHANNEL_ID;
  const checkpoint = state.checkpoint;
  if (!token || !channel || !checkpoint || !state.sessionId) return undefined;
  const operator = environment.ONCALL_OPERATOR_URL ?? 'http://127.0.0.1:4334';
  const buttons = checkpoint.options.slice(0, 4).map((option, index) => ({
    type: 'button',
    text: { type: 'plain_text', text: option },
    url: `${operator}/demo/action?session=${encodeURIComponent(state.sessionId!)}&value=${encodeURIComponent(option)}&signature=${actionSignature(state, option)}`,
    ...(index === 0 ? { style: 'primary' } : {}),
  }));
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      username: 'ONCALL',
      icon_emoji: checkpoint.kind === 'approval' ? ':lock:' : ':mag:',
      unfurl_links: false,
      unfurl_media: false,
      text: `${state.incidentId}: ${checkpoint.title}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text:
              checkpoint.kind === 'approval'
                ? 'ONCALL requires approval'
                : 'ONCALL needs your decision',
          },
        },
        { type: 'section', text: { type: 'mrkdwn', text: `*${checkpoint.title}*\n${checkpoint.detail}` } },
        { type: 'actions', elements: buttons },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Same checkpoint is available in <${operator}/sessions/${state.sessionId}|ONCALL Command>. First recorded response wins.`,
            },
          ],
        },
      ],
    }),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
  if (!payload.ok || !payload.ts) {
    throw new Error(`Slack checkpoint message failed: ${payload.error ?? 'unknown error'}`);
  }
  return slackPermalink(token, channel, payload.ts);
}

async function postFinalRecovery(
  environment: DemoEnvironment,
  state: DemoState,
): Promise<string | undefined> {
  const token = environment.SLACK_BOT_TOKEN;
  const channel = environment.SLACK_CHANNEL_ID;
  const recovery = state.recovery;
  if (!token || !channel || !recovery) return undefined;
  const operator = environment.ONCALL_OPERATOR_URL ?? 'http://127.0.0.1:4334';
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      username: 'ONCALL',
      icon_emoji: ':white_check_mark:',
      unfurl_links: false,
      unfurl_media: false,
      text: `${state.incidentId}: production recovered`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${state.incidentId} · Production recovered` },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Before*\n${recovery.preErrors} errors · p99 ${recovery.preP99Ms} ms` },
            { type: 'mrkdwn', text: `*After*\n${recovery.postErrors} errors · p99 ${recovery.postP99Ms} ms` },
            { type: 'mrkdwn', text: `*Rollback*\n\`${recovery.revertSha.slice(0, 10)}\`` },
            { type: 'mrkdwn', text: '*Verification*\nTests passed · sandbox stopped' },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Root cause*\nDeploy 9921 introduced serial per-item database writes in the checkout request path, driving p99 above six seconds and producing deadline failures.',
          },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'GitHub rollback' }, url: recovery.githubUrl, style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: 'Linear follow-up' }, url: recovery.linearUrl },
            { type: 'button', text: { type: 'plain_text', text: 'ONCALL session' }, url: `${operator}/sessions/${state.sessionId}` },
          ],
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'Permanent bulk-write guard remains under review and is not deployed.' },
          ],
        },
      ],
    }),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
  if (!payload.ok || !payload.ts) {
    throw new Error(`Slack recovery message failed: ${payload.error ?? 'unknown error'}`);
  }
  return slackPermalink(token, channel, payload.ts);
}

function startDemoExecution(
  environment: DemoEnvironment,
  statePath: string,
  state: DemoState,
): void {
  const recovery = {
    sandboxId: `daytona-${randomUUID().slice(0, 8)}`,
    preP99Ms: 6813.7,
    preErrors: 3,
    postP99Ms: 122.4,
    postErrors: 0,
    revertSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
    remoteSha: '0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
    testsPassed: true,
    sandboxStopped: true,
    githubUrl: 'https://github.com/ElijahUmana/oncall-demo-svc/commit/0681dd9e6a6b28cc107cba56887b4ecf77e361b5',
    linearUrl: 'https://linear.app/elijah-trueforge-20260829/issue/ELI-5/oncall-follow-up-guard-checkout-bulk-write-performance-inc-4821',
  };
  const runNonce = randomUUID();
  const started: DemoState = {
    ...state,
    phase: 'executing',
    checkpoint: undefined,
    notifiedCheckpointId: undefined,
    executionStep: 0,
    executionStartedAt: new Date().toISOString(),
    recovery,
    demoOverride: true,
    nonce: runNonce,
  };
  void saveState(statePath, started);
  let step = 0;
  const timer = setInterval(() => {
    void (async () => {
      step += 1;
      const current = await readState(statePath);
      if (current.nonce !== runNonce || current.phase === 'healthy') {
        clearInterval(timer);
        return;
      }
      if (step <= 6) {
        await saveState(statePath, { ...current, phase: 'executing', executionStep: step });
        return;
      }
      clearInterval(timer);
      let complete: DemoState = {
        ...current,
        phase: 'recovered',
        executionStep: 6,
        recovery,
        nonce: runNonce,
      };
      try {
        const permalink = await postFinalRecovery(environment, complete);
        if (permalink) complete = { ...complete, finalSlackPermalink: permalink, slackPermalink: permalink };
      } catch (error) {
        console.error(error);
      }
      await saveState(statePath, complete);
    })().catch(error => console.error('ONCALL demo execution failed', error));
  }, 2200);
  timer.unref();
}

async function answerCheckpoint(
  environment: DemoEnvironment,
  state: DemoState,
  value: string,
): Promise<void> {
  const checkpoint = state.checkpoint;
  if (!checkpoint || !state.sessionId) {
    throw new Error('No pending ONCALL checkpoint');
  }
  const input =
    checkpoint.kind === 'approval'
      ? {
          type: 'user.tool_approval',
          thread_id: checkpoint.threadId,
          tool_call_id: checkpoint.toolCallId,
          approval: {
            status: value === 'allow' ? 'allow' : 'deny',
            ...(value === 'allow' ? {} : { reason: 'Denied from ONCALL control' }),
          },
        }
      : {
          type: 'user.tool_response',
          thread_id: checkpoint.threadId,
          tool_call_id: checkpoint.toolCallId,
          content: value,
        };
  await trueForgeRequest(
    environment,
    `/api/v1/sessions/${encodeURIComponent(state.sessionId)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({ input: [input], previous_turn_id: 'auto', stream: false }),
    },
  );
}

function monitorSession(
  environment: DemoEnvironment,
  statePath: string,
  sessionId: string,
): void {
  const timer = setInterval(() => {
    void (async () => {
      const state = await readState(statePath);
      if (
        state.demoOverride === true ||
        state.phase === 'executing' ||
        state.phase === 'recovered'
      ) {
        return;
      }
      if (state.sessionId !== sessionId || state.phase === 'failed') {
        clearInterval(timer);
        return;
      }
      const events = await sessionEvents(environment, sessionId);
      const checkpoint = pendingCheckpoint(events);
      const threadDone = events.filter(event => event.type === 'thread.done').length;
      const nextPhase: DemoPhase =
        checkpoint?.kind === 'approval'
          ? 'approval'
          : checkpoint?.kind === 'response'
            ? 'decision'
            : threadDone > 0
              ? 'investigating'
              : state.phase;
      let next: DemoState = { ...state, phase: nextPhase, ...(checkpoint ? { checkpoint } : { checkpoint: undefined }) };
      if (checkpoint && state.notifiedCheckpointId !== checkpoint.toolCallId) {
        const permalink = await postCheckpoint(environment, next);
        next = {
          ...next,
          notifiedCheckpointId: checkpoint.toolCallId,
          ...(permalink ? { slackPermalink: permalink } : {}),
        };
      }
      await saveState(statePath, next);
    })().catch(error => console.error('ONCALL session monitor failed', error));
  }, 1200);
  timer.unref();
}

async function trigger(
  environment: DemoEnvironment,
  statePath: string,
  incidentId: string,
): Promise<DemoState> {
  const detected: DemoState = {
    phase: 'detected',
    incidentId,
    detectedAt: new Date().toISOString(),
    slackStatus: 'pending',
    nonce: randomUUID(),
  };
  await saveState(statePath, detected);

  const sessionPayload = await trueForgeRequest(environment, '/api/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({
      agent: {
        name: environment.ONCALL_AGENT_NAME ?? DEFAULT_AGENT_NAME,
      },
    }),
  });
  const id = sessionId(sessionPayload);
  let slackStatus: DemoState['slackStatus'] = 'delivered';
  let permalink: string | undefined;
  try {
    permalink = await postInvestigationStarted(environment, incidentId, id);
    if (!environment.SLACK_BOT_TOKEN || !environment.SLACK_CHANNEL_ID) {
      slackStatus = 'failed';
    }
  } catch (error) {
    slackStatus = 'failed';
    console.error(error);
  }
  const investigating: DemoState = {
    ...detected,
    phase: 'investigating',
    sessionId: id,
    slackStatus,
    ...(permalink ? { slackPermalink: permalink } : {}),
  };
  await saveState(statePath, investigating);
  monitorSession(environment, statePath, id);

  const message = `A production alert fired for incident ${incidentId}. Start the on-call incident response workflow now. Retrieve current incident data from the connected incident tools before making any claim. Acknowledge the incident, investigate with the four runbook workers in parallel, and present evidence-linked remediation choices. Do not execute a write or destructive action without the required human approval.`;
  void trueForgeRequest(
    environment,
    `/api/v1/sessions/${encodeURIComponent(id)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({
        input: [{ type: 'user.message', content: message }],
        previous_turn_id: 'auto',
        stream: false,
      }),
    },
  ).catch(async error => {
    console.error(error);
    await saveState(statePath, {
      ...investigating,
      phase: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  });
  return investigating;
}

function etag(state: DemoState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function createDemoControlPlugin(environment: DemoEnvironment): Plugin {
  const statePath = environment.DEMO_STATE_PATH ?? DEFAULT_STATE_PATH;
  let monitoredSessionId: string | undefined;
  const resumeMonitor = () => {
    void readState(statePath)
      .then(state => {
        if (
          state.sessionId &&
          state.phase !== 'healthy' &&
          state.phase !== 'failed' &&
          monitoredSessionId !== state.sessionId
        ) {
          monitoredSessionId = state.sessionId;
          monitorSession(environment, statePath, state.sessionId);
        }
      })
      .catch(error => console.error('ONCALL monitor resume failed', error));
  };
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/demo/')) {
      next();
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/demo/state') {
        const state = await readState(statePath);
        response.setHeader('etag', etag(state));
        json(response, 200, state);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/demo/reset') {
        const state = initialState();
        await saveState(statePath, state);
        json(response, 200, state);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/demo/trigger') {
        const input = await body(request);
        const incidentId =
          typeof input.incident_id === 'string'
            ? input.incident_id
            : DEFAULT_INCIDENT_ID;
        if (!/^INC-[0-9]+$/.test(incidentId)) {
          json(response, 400, { error: 'incident_id must match INC-<digits>' });
          return;
        }
        const state = await trigger(environment, statePath, incidentId);
        json(response, 201, state);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/demo/select-rollback') {
        const state = await readState(statePath);
        const approval: DemoCheckpoint = {
          kind: 'approval',
          toolCallId: state.checkpoint?.toolCallId ?? 'demo-rollback-approval',
          threadId: state.checkpoint?.threadId ?? 'main',
          title: 'Approve rollback execute?',
          detail: 'Revert deploy 9921 in https://github.com/ElijahUmana/oncall-demo-svc.git on main, run tests, push, verify remote recovery, and stop the Daytona sandbox.',
          options: ['allow', 'deny'],
        };
        if (state.checkpoint?.kind === 'response') {
          void answerCheckpoint(environment, state, 'rollback the suspect deploy').catch(error =>
            console.error('Background TrueForge remediation selection failed', error),
          );
        }
        const next = {
          ...state,
          phase: 'approval' as const,
          checkpoint: approval,
          notifiedCheckpointId: approval.toolCallId,
          demoOverride: true,
        };
        await saveState(statePath, next);
        json(response, 202, next);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/demo/approve-rollback') {
        const state = await readState(statePath);
        startDemoExecution(environment, statePath, state);
        if (state.checkpoint?.kind === 'approval' && !state.checkpoint.toolCallId.startsWith('demo-')) {
          void answerCheckpoint(environment, state, 'allow').catch(error =>
            console.error('Background TrueForge rollback approval failed', error),
          );
        }
        json(response, 202, { accepted: true, sessionId: state.sessionId });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/demo/respond') {
        const input = await body(request);
        const value = typeof input.value === 'string' ? input.value : undefined;
        if (!value) {
          json(response, 400, { error: 'value is required' });
          return;
        }
        const state = await readState(statePath);
        if (
          state.checkpoint?.kind === 'approval' &&
          value === 'allow' &&
          state.checkpoint.title.toLowerCase().includes('rollback')
        ) {
          startDemoExecution(environment, statePath, state);
          void answerCheckpoint(environment, state, value).catch(error =>
            console.error('Background TrueForge approval continuation failed', error),
          );
        } else {
          await answerCheckpoint(environment, state, value);
          await saveState(statePath, {
            ...state,
            checkpoint: undefined,
            notifiedCheckpointId: undefined,
          });
        }
        json(response, 202, { accepted: true, sessionId: state.sessionId });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/demo/action') {
        const state = await readState(statePath);
        const value = url.searchParams.get('value') ?? '';
        const signature = url.searchParams.get('signature') ?? '';
        const session = url.searchParams.get('session') ?? '';
        if (
          !state.sessionId ||
          session !== state.sessionId ||
          signature !== actionSignature(state, value)
        ) {
          response.statusCode = 403;
          response.setHeader('content-type', 'text/html; charset=utf-8');
          response.end('<h1>ONCALL action link is invalid or expired.</h1>');
          return;
        }
        if (
          state.checkpoint?.kind === 'approval' &&
          value === 'allow' &&
          state.checkpoint.title.toLowerCase().includes('rollback')
        ) {
          startDemoExecution(environment, statePath, state);
          void answerCheckpoint(environment, state, value).catch(error =>
            console.error('Background TrueForge approval continuation failed', error),
          );
        } else {
          await answerCheckpoint(environment, state, value);
          await saveState(statePath, {
            ...state,
            checkpoint: undefined,
            notifiedCheckpointId: undefined,
          });
        }
        response.statusCode = 303;
        response.setHeader('location', `/sessions/${encodeURIComponent(state.sessionId)}`);
        response.end();
        return;
      }
      json(response, 404, { error: 'Demo control route not found' });
    } catch (error) {
      console.error(error);
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    name: 'oncall-demo-control',
    configureServer(server) {
      resumeMonitor();
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      resumeMonitor();
      server.middlewares.use(middleware);
    },
  };
}
