import { createTrueForgeAgentUIServer } from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';

type NativeServer = ReturnType<typeof createTrueForgeAgentUIServer>;
type ServerFactory = typeof createTrueForgeAgentUIServer;
type ListSessionsRequest = Parameters<NativeServer['listSessions']>[0];

export function createOncallServer(
  {
    baseUrl,
    agentId,
  }: {
    baseUrl: string;
    agentId: string;
  },
  factory: ServerFactory = createTrueForgeAgentUIServer,
): NativeServer {
  if (!agentId.trim()) {
    throw new Error('VITE_ONCALL_AGENT_ID must identify the saved ONCALL agent');
  }
  const native = factory({ baseUrl });
  return {
    ...native,
    listSessions(request?: ListSessionsRequest) {
      return native.listSessions({ ...request, agentId });
    },
  };
}
