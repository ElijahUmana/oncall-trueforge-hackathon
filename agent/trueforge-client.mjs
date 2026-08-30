/** @typedef {Record<string, any>} JsonRecord */

export class TrueForgeClient {
  /**
   * @param {{ baseUrl?: string, token?: string, timeoutMs?: number }} options
   */
  constructor({
    baseUrl = 'http://127.0.0.1:8790',
    token,
    timeoutMs = 600_000,
  } = {}) {
    this.baseUrl = new URL(baseUrl);
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** @param {Record<string, string>} extra */
  headers(extra = {}) {
    return {
      accept: 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {{ body?: unknown, expected?: number[], query?: Record<string, unknown> }} options
   * @returns {Promise<JsonRecord>}
   */
  async request(method, pathname, { body, expected = [200], query } = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: this.headers(
        body === undefined ? {} : { 'content-type': 'application/json' },
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new Error(
        `${method} ${url.pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    if (!expected.includes(response.status)) {
      throw new Error(
        `${method} ${url.pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
      );
    }
    return payload;
  }

  /**
   * @param {string} pathname
   * @param {unknown} body
   * @param {(event: JsonRecord, id?: string) => void | Promise<void>} onEvent
   * @param {{ maxReconnectAttempts?: number }} options
   */
  async stream(pathname, body, onEvent, { maxReconnectAttempts = 2 } = {}) {
    if (!Number.isInteger(maxReconnectAttempts) || maxReconnectAttempts < 0) {
      throw new Error('maxReconnectAttempts must be a non-negative integer');
    }

    let lastSequenceNumber = 0;
    let turnId;
    let terminalSeen = false;
    const deliveredSequenceIds = new Set();

    /** @param {Response} response @param {string} operation */
    const consume = async (response, operation) => {
      if (!response.ok || response.body === null) {
        throw new Error(
          `${operation} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`,
        );
      }

      let buffer = '';
      const decoder = new TextDecoder();
      /** @param {string} frame */
      const deliver = async frame => {
        const parsed = parseSseFrame(frame);
        if (parsed === null) return;
        if (parsed.id !== undefined) {
          if (deliveredSequenceIds.has(parsed.id)) return;
          deliveredSequenceIds.add(parsed.id);
          const sequenceNumber = Number(parsed.id);
          if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) {
            throw new Error(`Invalid SSE sequence id: ${parsed.id}`);
          }
          lastSequenceNumber = Math.max(lastSequenceNumber, sequenceNumber);
        }
        if (parsed.data.type === 'turn.created') {
          turnId = String(parsed.data.turn_id);
        }
        if (parsed.data.type === 'turn.done') terminalSeen = true;
        await onEvent(parsed.data, parsed.id);
      };

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) await deliver(frame);
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) await deliver(buffer);
    };

    const initialResponse = await fetch(new URL(pathname, this.baseUrl), {
      method: 'POST',
      headers: this.headers({
        accept: 'text/event-stream',
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await consume(initialResponse, `POST ${pathname}`);

    let reconnectAttempts = 0;
    while (!terminalSeen) {
      if (turnId === undefined) {
        throw new Error(
          `SSE stream ${pathname} ended before turn.created and turn.done; cannot reconnect`,
        );
      }
      if (reconnectAttempts >= maxReconnectAttempts) {
        throw new Error(
          `SSE stream ${pathname} ended before turn.done after ${reconnectAttempts} reconnect attempts`,
        );
      }
      reconnectAttempts += 1;
      const subscribePath = `${pathname}/${encodeURIComponent(turnId)}/subscribe`;
      const subscribeUrl = new URL(subscribePath, this.baseUrl);
      subscribeUrl.searchParams.set(
        'after_sequence_number',
        String(lastSequenceNumber),
      );
      const response = await fetch(subscribeUrl, {
        method: 'GET',
        headers: this.headers({ accept: 'text/event-stream' }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await consume(response, `GET ${subscribePath}`);
    }

    return lastSequenceNumber;
  }
}

/**
 * @param {string} frame
 * @returns {{ id?: string, data: JsonRecord } | null}
 */
export function parseSseFrame(frame) {
  let id;
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'id') id = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const text = data.join('\n');
  try {
    return { id, data: JSON.parse(text) };
  } catch {
    throw new Error(`Invalid JSON SSE data: ${text.slice(0, 500)}`);
  }
}

/**
 * @param {Pick<TrueForgeClient, 'request'>} client
 * @param {string} name
 * @returns {Promise<JsonRecord | undefined>}
 */
export async function findAgentByName(client, name) {
  const agents = await listAll(client, '/api/v1/agents');
  return agents.find(agent => agent.name === name);
}

/**
 * @param {Pick<TrueForgeClient, 'request'>} client
 * @param {string} pathname
 * @param {{ query?: Record<string, unknown>, dataKey?: string }} options
 * @returns {Promise<JsonRecord[]>}
 */
export async function listAll(
  client,
  pathname,
  { query = {}, dataKey = 'data' } = {},
) {
  /** @type {JsonRecord[]} */
  const items = [];
  /** @type {string | undefined} */
  let pageToken;
  do {
    const page = await client.request('GET', pathname, {
      query: { ...query, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    items.push(...(page[dataKey] ?? []));
    pageToken = page.pagination?.next_page_token;
  } while (pageToken);
  return items;
}
