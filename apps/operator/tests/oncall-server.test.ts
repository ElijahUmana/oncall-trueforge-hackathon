import { describe, expect, it, vi } from 'vitest';
import { createOncallServer } from '../src/oncall-server';

function fakeServer() {
  return {
    listSessions: vi.fn().mockResolvedValue({ data: [], nextPageToken: undefined }),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
  };
}

describe('createOncallServer', () => {
  it('uses the immutable agent ID for history without changing other filters', async () => {
    const native = fakeServer();
    const factory = vi.fn().mockReturnValue(native);
    const server = createOncallServer(
      {
        baseUrl: 'http://127.0.0.1:8790',
        agentId: 'agent-immutable-id',
      },
      factory as never,
    );

    await server.listSessions({
      agentId: 'oncall-incident-responder',
      pageToken: 'page-2',
      limit: 25,
    });

    expect(native.listSessions).toHaveBeenCalledWith({
      agentId: 'agent-immutable-id',
      pageToken: 'page-2',
      limit: 25,
    });
  });

  it('preserves native named-agent session creation', async () => {
    const native = fakeServer();
    const server = createOncallServer(
      {
        baseUrl: 'http://127.0.0.1:8790',
        agentId: 'agent-immutable-id',
      },
      vi.fn().mockReturnValue(native) as never,
    );

    await server.createSession({ agentName: 'oncall-incident-responder' });

    expect(native.createSession).toHaveBeenCalledWith({
      agentName: 'oncall-incident-responder',
    });
  });

  it('fails closed when the immutable agent ID is absent', () => {
    expect(() =>
      createOncallServer(
        { baseUrl: 'http://127.0.0.1:8790', agentId: ' ' },
        vi.fn() as never,
      ),
    ).toThrow('VITE_ONCALL_AGENT_ID must identify the saved ONCALL agent');
  });
});
