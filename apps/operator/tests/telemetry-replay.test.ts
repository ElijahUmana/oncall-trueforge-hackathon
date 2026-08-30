import { describe, expect, it } from 'vitest';
import { orderReplayEvents, replayEvents } from '../src/telemetry-replay';
import { createTelemetryStore } from '../src/telemetry-store';

const callEvent = {
  type: 'model.message',
  sequence_number: 10,
  created_at: '2026-08-29T21:00:00Z',
  tool_calls: [
    {
      id: 'logs-1',
      name: 'call_tool',
      args: JSON.stringify({
        mcp_server: 'checkout-svc-sim',
        tool_name: 'logs_query',
      }),
    },
  ],
};

const responseEvent = {
  type: 'tool.response',
  sequence_number: 11,
  created_at: '2026-08-29T21:00:00Z',
  tool_call_id: 'logs-1',
  content: JSON.stringify({ count: 25 }),
};

describe('telemetry replay', () => {
  it('orders by sequence number, then falls back to deterministic event time', () => {
    const sameTimeFirst = {
      id: 'event-a',
      type: 'thread.created',
      created_at: '2026-08-29T21:00:01Z',
      marker: 'first',
    };
    const sameTimeSecond = {
      id: 'event-b',
      type: 'thread.done',
      created_at: '2026-08-29T21:00:01Z',
      marker: 'second',
    };
    const earlier = {
      id: 'event-0',
      type: 'turn.created',
      created_at: '2026-08-29T22:00:00+01:00',
    };
    const mixedSequence = {
      id: 'event-c',
      type: 'model.message',
      sequence_number: 1,
      created_at: '2026-08-29T21:00:02Z',
      marker: 'mixed',
    };

    expect(
      orderReplayEvents([responseEvent, callEvent]).map(
        event => event.sequence_number,
      ),
    ).toEqual([10, 11]);
    expect(
      orderReplayEvents([
        sameTimeSecond,
        mixedSequence,
        sameTimeFirst,
        earlier,
      ]).map(event => event.id),
    ).toEqual(['event-0', 'event-a', 'event-b', 'event-c']);
  });

  it('produces the same snapshot for oldest-first and newest-first pages', () => {
    const oldestFirst = createTelemetryStore();
    const newestFirst = createTelemetryStore();

    replayEvents([callEvent, responseEvent], oldestFirst);
    replayEvents([responseEvent, callEvent], newestFirst);

    expect(newestFirst.getSnapshot()).toEqual(oldestFirst.getSnapshot());
    expect(newestFirst.getSnapshot().tools['logs-1']).toMatchObject({
      name: 'logs_query',
      provider: 'checkout-svc-sim',
      status: 'success',
      evidenceSnippet: '25 log lines',
    });
  });
});
