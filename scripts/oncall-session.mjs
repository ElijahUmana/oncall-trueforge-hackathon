import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { AGENT_NAME } from '../agent/definition.mjs';
import { TrueForgeClient, listAll } from '../agent/trueforge-client.mjs';

/** @typedef {Record<string, any>} JsonRecord */

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
const token = process.env.TRUEFORGE_TOKEN;
const agentName = process.env.ONCALL_AGENT_NAME ?? AGENT_NAME;
const statePath = path.resolve(
  process.env.ONCALL_SESSION_STATE ?? '.oncall/session.json',
);
const client = new TrueForgeClient({ baseUrl, token });

/** @returns {Promise<JsonRecord>} */
async function loadState() {
  try {
    return /** @type {JsonRecord} */ (
      JSON.parse(await readFile(statePath, 'utf8'))
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
}

/** @param {JsonRecord} state */
async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** @param {JsonRecord} event */
function summarizeEvent(event) {
  if (event.type === 'thread.created')
    return `subagent started: ${event.title}`;
  if (event.type === 'thread.done')
    return `subagent finished: ${event.title} (${event.state?.status ?? 'unknown'})`;
  if (event.type === 'tool.approval_required')
    return `approval required on ${event.thread_id}: ${/** @type {JsonRecord[]} */ (event.tool_calls ?? []).map(call => call.id).join(', ')}`;
  if (event.type === 'tool.response_required')
    return `user response required on ${event.thread_id}: ${/** @type {JsonRecord[]} */ (event.tool_calls ?? []).map(call => call.id).join(', ')}`;
  if (event.type === 'sandbox.created')
    return `sandbox created: ${event.sandbox_id}`;
  if (event.type === 'turn.done') return `turn done: ${event.state?.status}`;
  if (event.type === 'model.message' && event.content) return event.content;
  return event.type;
}

/** @param {string} sessionId @param {JsonRecord[]} input */
async function streamTurn(sessionId, input) {
  let turnId;
  let finalState;
  const lastSequenceNumber = await client.stream(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    { input },
    async event => {
      if (event.type === 'turn.created') turnId = event.turn_id;
      if (event.type === 'turn.done') finalState = event.state;
      process.stdout.write(`${summarizeEvent(event)}\n`);
    },
  );
  const state = await loadState();
  await saveState({
    ...state,
    session_id: sessionId,
    turn_id: turnId,
    last_sequence_number: lastSequenceNumber,
  });
  return { turnId, finalState };
}

async function openSession() {
  const response = await client.request('POST', '/api/v1/sessions', {
    body: { agent: { name: agentName } },
    expected: [201],
  });
  await saveState({
    session_id: response.data.id,
    created_at: response.data.created_at,
  });
  process.stdout.write(`${response.data.id}\n`);
}

/** @param {string} content */
async function sendMessage(content) {
  const state = await loadState();
  if (!state.session_id)
    throw new Error(`No persisted session at ${statePath}; run "open" first`);
  await streamTurn(state.session_id, [{ type: 'user.message', content }]);
}

async function pendingActions() {
  const state = await loadState();
  if (!state.session_id)
    throw new Error(`No persisted session at ${statePath}`);
  const turns = await listAll(
    client,
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}/turns`,
  );
  const turn =
    turns.find(candidate => candidate.id === state.turn_id) ?? turns[0];
  const actions =
    turn?.state?.status === 'done' ? (turn.state.required_actions ?? []) : [];
  process.stdout.write(`${JSON.stringify(actions, null, 2)}\n`);
}

/**
 * @param {string} toolCallId
 * @param {'allow' | 'deny'} status
 * @param {string} [reason]
 */
async function decide(toolCallId, status, reason) {
  const state = await loadState();
  if (!state.session_id || !state.turn_id)
    throw new Error(`No persisted paused turn at ${statePath}`);
  const events = await listAll(
    client,
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}/turns/${encodeURIComponent(state.turn_id)}/events`,
    { query: { order: 'asc' } },
  );
  /** @type {Array<{ id: string, thread_id: string } & JsonRecord>} */
  const pendingCalls = events
    .filter(event => event.type === 'tool.approval_required')
    .flatMap(event =>
      /** @type {JsonRecord[]} */ (event.tool_calls ?? [])
        .filter(call => typeof call.id === 'string')
        .map(call => ({
          ...call,
          id: String(call.id),
          thread_id: String(event.thread_id),
        })),
    );
  const pending = pendingCalls.find(call => call.id === toolCallId);
  if (!pending)
    throw new Error(`No pending approval found for tool call ${toolCallId}`);
  const approval =
    status === 'allow' ? { status } : { status, ...(reason ? { reason } : {}) };
  await streamTurn(state.session_id, [
    {
      type: 'user.tool_approval',
      thread_id: pending.thread_id,
      tool_call_id: pending.id,
      approval,
    },
  ]);
}

/** @param {string} toolCallId @param {string} content */
async function respond(toolCallId, content) {
  const state = await loadState();
  if (!state.session_id || !state.turn_id)
    throw new Error(`No persisted paused turn at ${statePath}`);
  const events = await listAll(
    client,
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}/turns/${encodeURIComponent(state.turn_id)}/events`,
    { query: { order: 'asc' } },
  );
  /** @type {Array<{ id: string, thread_id: string } & JsonRecord>} */
  const pendingCalls = events
    .filter(event => event.type === 'tool.response_required')
    .flatMap(event =>
      /** @type {JsonRecord[]} */ (event.tool_calls ?? [])
        .filter(call => typeof call.id === 'string')
        .map(call => ({
          ...call,
          id: String(call.id),
          thread_id: String(event.thread_id),
        })),
    );
  const pending = pendingCalls.find(call => call.id === toolCallId);
  if (!pending)
    throw new Error(`No pending response found for tool call ${toolCallId}`);
  await streamTurn(state.session_id, [
    {
      type: 'user.tool_response',
      thread_id: pending.thread_id,
      tool_call_id: pending.id,
      content,
    },
  ]);
}

async function audit() {
  const state = await loadState();
  if (!state.session_id)
    throw new Error(`No persisted session at ${statePath}`);
  const session = await client.request(
    'GET',
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}`,
  );
  const events = await listAll(
    client,
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}/events`,
  );
  const auditRecord = {
    captured_at: new Date().toISOString(),
    session: session.data,
    events,
    counts: Object.fromEntries(
      [...new Set(events.map(item => item.event.type))]
        .sort()
        .map(type => [
          type,
          events.filter(item => item.event.type === type).length,
        ]),
    ),
  };
  process.stdout.write(`${JSON.stringify(auditRecord, null, 2)}\n`);
}

async function verifyPersistence() {
  const state = await loadState();
  if (!state.session_id)
    throw new Error(`No persisted session at ${statePath}`);
  const session = await client.request(
    'GET',
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}`,
  );
  const events = await listAll(
    client,
    `/api/v1/sessions/${encodeURIComponent(state.session_id)}/events`,
  );
  if (events.length === 0)
    throw new Error(`Session ${state.session_id} has no persisted events`);
  process.stdout.write(
    `${JSON.stringify({ session_id: session.data.id, persisted_events: events.length }, null, 2)}\n`,
  );
}

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();
const [command, ...args] = cliArgs;
if (command === 'open') await openSession();
else if (command === 'send') await sendMessage(args.join(' '));
else if (command === 'pending') await pendingActions();
else if (command === 'allow') {
  const [toolCallId] = args;
  if (!toolCallId) throw new Error('allow requires <tool-call-id>');
  await decide(toolCallId, 'allow');
} else if (command === 'deny') {
  const [toolCallId, ...reason] = args;
  if (!toolCallId) throw new Error('deny requires <tool-call-id>');
  await decide(toolCallId, 'deny', reason.join(' '));
} else if (command === 'respond') {
  const [toolCallId, ...content] = args;
  if (!toolCallId) throw new Error('respond requires <tool-call-id> <content>');
  if (content.length === 0)
    throw new Error('respond requires non-empty <content>');
  await respond(toolCallId, content.join(' '));
} else if (command === 'audit') await audit();
else if (command === 'verify-persistence') await verifyPersistence();
else {
  throw new Error(
    'Usage: oncall-session.mjs open | send <message> | pending | allow <tool-call-id> | deny <tool-call-id> [reason] | respond <tool-call-id> <content> | audit | verify-persistence',
  );
}
