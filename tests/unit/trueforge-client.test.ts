import { describe, expect, it } from 'vitest';

import { parseSseFrame } from '../../agent/trueforge-client.mjs';

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
