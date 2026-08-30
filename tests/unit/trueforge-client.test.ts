import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TrueForgeClient,
  findAgentByName,
  listAll,
  parseSseFrame,
} from '../../agent/trueforge-client.mjs';

function sseResponse(frames: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  );
}

function event(id: number, data: Record<string, unknown>) {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TrueForge SSE parser', () => {
  it('parses an event ID and multiline JSON data', () => {
    expect(
      parseSseFrame(
        'id: 42\ndata: {"type":"turn.done",\ndata: "thread_id":null}',
      ),
    ).toEqual({
      id: '42',
      data: { type: 'turn.done', thread_id: null },
    });
  });

  it('ignores comments and empty frames', () => {
    expect(parseSseFrame(': heartbeat')).toBeNull();
  });

  it('fails loudly for malformed JSON event data', () => {
    expect(() => parseSseFrame('data: not-json')).toThrow(
      'Invalid JSON SSE data',
    );
  });
});

describe('TrueForge turn streaming', () => {
  it('accepts a stream only after terminal turn.done', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          event(1, { type: 'turn.created', turn_id: 'turn-1' }),
          event(2, { type: 'model.message', content: 'done' }),
          event(3, { type: 'turn.done', state: { status: 'done' } }),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const client = new TrueForgeClient();

    const cursor = await client.stream(
      '/api/v1/sessions/s1/turns',
      {},
      item => {
        seen.push(String(item.type));
      },
    );

    expect(cursor).toBe(3);
    expect(seen).toEqual(['turn.created', 'model.message', 'turn.done']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects a truncated stream and suppresses duplicate replay', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          event(1, { type: 'turn.created', turn_id: 'turn-1' }),
          event(2, { type: 'model.message', content: 'partial' }),
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          event(2, { type: 'model.message', content: 'partial' }),
          event(3, { type: 'tool.response', content: '{}' }),
          event(4, { type: 'turn.done', state: { status: 'done' } }),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const seen: number[] = [];
    const client = new TrueForgeClient();

    const cursor = await client.stream(
      '/api/v1/sessions/s1/turns',
      {},
      (_item, id) => {
        seen.push(Number(id));
      },
    );

    expect(cursor).toBe(4);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const subscribeUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(subscribeUrl.pathname).toBe(
      '/api/v1/sessions/s1/turns/turn-1/subscribe',
    );
    expect(subscribeUrl.searchParams.get('after_sequence_number')).toBe('2');
  });

  it('fails after bounded reconnect attempts without turn.done', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([event(1, { type: 'turn.created', turn_id: 'turn-1' })]),
      )
      .mockResolvedValue(sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = new TrueForgeClient();

    await expect(
      client.stream('/api/v1/sessions/s1/turns', {}, () => undefined, {
        maxReconnectAttempts: 2,
      }),
    ).rejects.toThrow('ended before turn.done after 2 reconnect attempts');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails without persisting completion when turn.created is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            event(1, { type: 'model.message', content: 'partial' }),
          ]),
        ),
    );
    const client = new TrueForgeClient();

    await expect(
      client.stream('/api/v1/sessions/s1/turns', {}, () => undefined),
    ).rejects.toThrow('ended before turn.created and turn.done');
  });
});

describe('TrueForge pagination', () => {
  it('finds an existing saved agent on a later page', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'other', name: 'other-agent' }],
        pagination: { next_page_token: 'page-2' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'target', name: 'oncall-incident-responder' }],
        pagination: {},
      });

    const result = await findAgentByName(
      { request },
      'oncall-incident-responder',
    );

    expect(result).toEqual({
      id: 'target',
      name: 'oncall-incident-responder',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('loads every page using next_page_token', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'first' }],
        pagination: { next_page_token: 'next-token' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'second' }],
        pagination: {},
      });

    const result = await listAll({ request }, '/api/v1/agents', {
      query: { order: 'asc' },
    });

    expect(result).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(request).toHaveBeenNthCalledWith(1, 'GET', '/api/v1/agents', {
      query: { order: 'asc' },
    });
    expect(request).toHaveBeenNthCalledWith(2, 'GET', '/api/v1/agents', {
      query: { order: 'asc', page_token: 'next-token' },
    });
  });
});
