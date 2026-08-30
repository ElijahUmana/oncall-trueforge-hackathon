import {
  SPECIALIST_NAMES,
  type SpecialistName,
  type TelemetryAction,
  type TelemetryStore,
} from './telemetry-store';

type EventRecord = Record<string, unknown> & { type?: unknown };
type ToolCallRecord = {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  function?: unknown;
  tool_info?: unknown;
};

type IngestionContext = {
  threadNames: Map<string, SpecialistName>;
  toolCalls: Map<
    string,
    { name: string; provider?: string; worker?: SpecialistName }
  >;
};

export function createIngestionContext(): IngestionContext {
  return { threadNames: new Map(), toolCalls: new Map() };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function specialist(value: unknown): SpecialistName | undefined {
  const name = string(value);
  return name && SPECIALIST_NAMES.includes(name as SpecialistName)
    ? (name as SpecialistName)
    : undefined;
}

function isInfrastructureTool(name: string): boolean {
  return (
    name === 'get_tool_info' ||
    name === 'list_tools' ||
    name === 'exec' ||
    name === 'get_openui_instructions'
  );
}

function statusFromThread(value: unknown): 'success' | 'error' | 'unavailable' {
  const state = object(value);
  if (state?.status === 'error') return 'error';
  const output = object(state?.output);
  const content = parseJson(output?.content);
  if (content?.status === 'insufficient') return 'error';
  if (content?.status === 'complete') return 'success';
  return 'unavailable';
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toolIdentity(call: ToolCallRecord):
  | {
      name: string;
      provider?: string;
      input?: Record<string, unknown>;
    }
  | undefined {
  const fn = object(call.function);
  const outerName = string(fn?.name) ?? string(call.name);
  if (!outerName) return undefined;
  const args = parseJson(fn?.arguments ?? call.args);
  const innerName = string(args?.tool_name);
  const mcpServer = string(args?.mcp_server);
  const info = object(call.tool_info);
  const provider =
    mcpServer ?? string(info?.server_name) ?? string(info?.server_id);
  return {
    name: innerName ?? outerName,
    ...(provider ? { provider } : {}),
    ...(object(args?.input) ? { input: object(args?.input) } : {}),
  };
}

function conciseEvidence(payload: Record<string, unknown>): string | undefined {
  const incident = object(payload.incident);
  if (incident) {
    const id = string(incident.id);
    const status = string(incident.status);
    if (id && status) return `${id} ${status}`;
  }
  const deploy = object(payload.deploy);
  if (deploy) {
    const id = string(deploy.id);
    const commit = string(deploy.commit);
    if (id && commit) return `deploy ${id} · ${commit.slice(0, 8)}`;
  }
  if (typeof payload.count === 'number') return `${payload.count} log lines`;
  if (Array.isArray(payload.points))
    return `${payload.points.length} metric points`;
  const path = string(payload.path);
  if (path) return path;
  return undefined;
}

function numberText(value: unknown): string {
  return typeof value === 'number' ? String(value) : '?';
}

function resultActions(
  key: string,
  call: { name: string; provider?: string; worker?: SpecialistName },
  payload: Record<string, unknown> | undefined,
): TelemetryAction[] {
  const actions: TelemetryAction[] = [
    {
      type: 'tool',
      key,
      name: call.name,
      status:
        payload === undefined
          ? 'unavailable'
          : payload.error
            ? 'error'
            : 'success',
      ...(call.provider ? { provider: call.provider } : {}),
      ...(call.worker ? { worker: call.worker } : {}),
      ...(payload && conciseEvidence(payload)
        ? { evidenceSnippet: conciseEvidence(payload) }
        : {}),
    },
  ];

  if (payload?.revert_sha && payload.post_evidence) {
    const post = object(payload.post_evidence);
    const summary = post
      ? `${numberText(post.requests)} requests · ${numberText(post.errors)} errors · p99 ${numberText(post.p99_ms)}ms`
      : undefined;
    actions.push({
      type: 'recovery',
      evidence: {
        repositoryUrl: string(payload.repository_url),
        branch: string(payload.branch),
        sandboxId: string(payload.sandbox_id),
        pre: object(payload.pre_evidence)
          ? {
              requests: Number(object(payload.pre_evidence)?.requests),
              errors: Number(object(payload.pre_evidence)?.errors),
              errorRate: Number(object(payload.pre_evidence)?.error_rate),
              p99Ms: Number(object(payload.pre_evidence)?.p99_ms),
            }
          : undefined,
        revertSha: string(payload.revert_sha),
        testsPassed: payload.tests_passed === true,
        post: post
          ? {
              requests: Number(post.requests),
              errors: Number(post.errors),
              errorRate: Number(post.error_rate),
              p99Ms: Number(post.p99_ms),
            }
          : undefined,
        remoteSha: string(payload.remote_sha),
        sandboxStopped: payload.sandbox_stopped === true,
      },
    });
    actions.push({
      type: 'sandbox',
      status: payload.sandbox_stopped === true ? 'success' : 'error',
      name: string(payload.sandbox_id) ?? 'Daytona',
      exitCode: payload.tests_passed === true ? 0 : 1,
      ...(summary ? { resultSummary: summary } : {}),
    });
  }
  if (payload?.delivered === true) {
    actions.push({
      type: 'closeout',
      provider: 'slack',
      status: 'success',
      ...(string(payload.permalink)
        ? { reference: string(payload.permalink) }
        : {}),
    });
  }
  const issueId = string(payload?.id);
  if (issueId?.startsWith('ELI-')) {
    actions.push({
      type: 'closeout',
      provider: 'linear',
      status: 'success',
      reference: issueId,
    });
  }
  const incident = object(payload?.incident);
  if (incident) {
    const symptoms = object(incident.symptoms);
    actions.push({
      type: 'incident',
      facts: {
        ...(string(incident.id) ? { id: string(incident.id) } : {}),
        ...(string(incident.service)
          ? { service: string(incident.service) }
          : {}),
        ...(string(incident.severity)
          ? { severity: string(incident.severity) }
          : {}),
        ...(string(incident.status) ? { status: string(incident.status) } : {}),
        ...(typeof symptoms?.peak_p99_ms === 'number'
          ? { peakP99Ms: symptoms.peak_p99_ms }
          : {}),
        ...(typeof symptoms?.peak_error_rate_pct === 'number'
          ? { peakErrorRatePct: symptoms.peak_error_rate_pct }
          : {}),
      },
    });
  }
  if (incident?.status === 'resolved') {
    actions.push({
      type: 'closeout',
      provider: 'pagerduty',
      status: 'success',
      reference: string(incident.id),
    });
  }
  return actions;
}

export function ingestEvent(
  event: EventRecord,
  store: TelemetryStore,
  context: IngestionContext,
): void {
  const type = string(event.type);
  const threadId = string(event.thread_id);

  if (type === 'turn.created' && Array.isArray(event.input)) {
    for (const rawInput of event.input) {
      const input = object(rawInput);
      if (input?.type === 'user.tool_response') {
        store.dispatch({ type: 'choice', status: 'answered' });
      }
      if (input?.type === 'user.tool_approval') {
        const approval = object(input.approval);
        const toolCallId = string(input.tool_call_id);
        const call = toolCallId ? context.toolCalls.get(toolCallId) : undefined;
        store.dispatch({
          type: 'approval',
          toolCallId,
          toolName: call?.name ?? 'approved operation',
          status: approval?.status === 'allow' ? 'allowed' : 'denied',
          reason: string(approval?.reason),
          completedAt: string(event.created_at),
        });
      }
    }
    return;
  }
  if (type === 'thread.created' && threadId) {
    const name = specialist(event.title);
    if (!name) return;
    context.threadNames.set(threadId, name);
    store.dispatch({ type: 'worker', name, status: 'running', stepCount: 0 });
    return;
  }
  if (type === 'thread.done' && threadId) {
    const name = context.threadNames.get(threadId) ?? specialist(event.title);
    if (!name) return;
    store.dispatch({
      type: 'worker',
      name,
      status: statusFromThread(event.state),
    });
    const output = object(object(event.state)?.output);
    const content = parseJson(output?.content);
    const evidence = content?.evidence;
    if (Array.isArray(evidence)) {
      evidence.forEach((item, index) => {
        const entry = object(item);
        const tool = string(entry?.tool) ?? `${name}-evidence`;
        const observations = entry?.observations;
        store.dispatch({
          type: 'tool',
          key: `${threadId}:${tool}:${index}`,
          name: tool,
          status: 'success',
          worker: name,
          ...(Array.isArray(observations) && string(observations[0])
            ? { evidenceSnippet: string(observations[0]) }
            : {}),
        });
      });
    }
    return;
  }
  if (type === 'model.message' && Array.isArray(event.tool_calls)) {
    for (const rawCall of event.tool_calls) {
      const call = rawCall as ToolCallRecord;
      const id = string(call.id);
      const identity = toolIdentity(call);
      if (!id || !identity) continue;
      const worker = threadId ? context.threadNames.get(threadId) : undefined;
      const evidenceWorker =
        worker && !isInfrastructureTool(identity.name) ? worker : undefined;
      context.toolCalls.set(id, {
        ...identity,
        ...(evidenceWorker ? { worker: evidenceWorker } : {}),
      });
      store.dispatch({
        type: 'tool',
        key: id,
        name: identity.name,
        status: 'running',
        ...(identity.provider ? { provider: identity.provider } : {}),
        ...(worker && !isInfrastructureTool(identity.name) ? { worker } : {}),
      });
    }
    return;
  }
  if (type === 'tool.response') {
    const toolCallId = string(event.tool_call_id);
    if (!toolCallId) return;
    const call = context.toolCalls.get(toolCallId);
    if (!call) return;
    const payload = parseJson(event.content);
    resultActions(toolCallId, call, payload).forEach(action =>
      store.dispatch(action),
    );
    return;
  }
  if (type === 'tool.approval_required') {
    const refs = Array.isArray(event.tool_calls) ? event.tool_calls : [];
    const callId = string(object(refs[0])?.id);
    const call = callId ? context.toolCalls.get(callId) : undefined;
    store.dispatch({
      type: 'approval',
      id: string(event.id),
      toolCallId: callId,
      toolName: call?.name ?? 'approved operation',
      status: 'pending',
    });
    return;
  }
  if (type === 'tool.response_required') {
    store.dispatch({ type: 'choice', status: 'pending' });
  }
}

export function ingestEvents(
  events: EventRecord[],
  store: TelemetryStore,
  context = createIngestionContext(),
): IngestionContext {
  [...events]
    .sort((left, right) => {
      const leftTime = string(left.created_at) ?? '';
      const rightTime = string(right.created_at) ?? '';
      return leftTime.localeCompare(rightTime);
    })
    .forEach(event => ingestEvent(event, store, context));
  return context;
}
