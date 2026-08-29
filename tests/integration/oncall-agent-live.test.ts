import { describe, expect, test } from 'vitest';

const live = process.env.LIVE_INTEGRATION === '1';
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';

interface ToolAnnotations {
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

interface McpTool {
  name: string;
  annotations: ToolAnnotations;
}

interface AgentRecord {
  name: string;
  manifest: {
    model: { name: string };
    instructions: string;
    skills: Array<{ name: string }>;
    mcp_servers: Array<{
      name: string;
      enable_tools: string[];
      require_approval_for_tools: string[];
    }>;
    config: Record<string, unknown>;
  };
}

async function getJson<T>(pathname: string): Promise<T> {
  const response = await fetch(new URL(pathname, baseUrl));
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

describe.skipIf(!live)('live ONCALL saved agent', () => {
  test('is registered with native capabilities, approval policy, and stable compaction', async () => {
    const agents = await getJson<{ data: AgentRecord[] }>('/api/v1/agents');
    const agent = agents.data.find(
      candidate => candidate.name === 'oncall-incident-responder',
    );
    expect(agent).toBeDefined();
    if (agent === undefined) throw new Error('ONCALL saved agent is absent');
    expect(agent.manifest.model.name).toBe('openai/gpt-5.6-sol');
    expect(agent.manifest.skills).toEqual([{ name: 'oncall-runbook' }]);
    expect(agent.manifest.config).toMatchObject({
      sandbox: { enabled: true },
      dynamic_sub_agents: { enabled: true },
      generative_ui: { enabled: true },
      ask_user_questions: { enabled: true },
      context_management: {
        compaction: { enabled: true, compaction_threshold_tokens: 50_000 },
        large_tool_response: { enabled: true },
      },
    });
    const [server, linearServer] = agent.manifest.mcp_servers;
    expect(server).toBeDefined();
    if (server === undefined)
      throw new Error('ONCALL connector policy is absent');
    expect(server.require_approval_for_tools).toEqual(
      expect.arrayContaining([
        '@destructive',
        'rollback_execute',
        'pagerduty_resolve',
        'slack_post_message',
      ]),
    );
    expect(server.require_approval_for_tools).not.toContain(
      'pagerduty_acknowledge',
    );
    expect(server.require_approval_for_tools).not.toContain(
      'jira_create_issue',
    );
    expect(linearServer).toMatchObject({
      name: 'linear',
      enable_tools: ['get_workspace', 'list_teams', 'save_issue', 'get_issue'],
      require_approval_for_tools: ['@destructive', 'save_issue'],
    });
    expect(agent.manifest.instructions).toContain(
      'call create_sub_agent exactly four times',
    );
    expect(agent.manifest.instructions).toContain(
      'rollback_execute executes the approved revert in an isolated Daytona sandbox',
    );
    expect(agent.manifest.instructions).toContain(
      'sandbox_deleted must be true',
    );
    expect(agent.manifest.instructions).toContain(
      'success === true and response.exitCode === 0',
    );
    expect(agent.manifest.instructions).toContain(
      'Do not run a second git revert with the native sandbox tool',
    );
    expect(agent.manifest.instructions).toContain(
      'revert_sha and remote_sha must be identical full Git SHAs',
    );
  });

  test('publishes every required custom and Linear tool with safety annotations', async () => {
    const response = await getJson<{ data: McpTool[] }>(
      '/api/v1/mcp-servers/checkout-svc-sim/tools',
    );
    const tools = new Map(response.data.map(tool => [tool.name, tool]));
    for (const name of [
      'pagerduty_get_incident',
      'pagerduty_acknowledge',
      'pagerduty_resolve',
      'logs_query',
      'metrics_query',
      'deploys_list',
      'deploy_get',
      'code_get_file',
      'rollback_execute',
      'audit_list',
      'slack_post_message',
    ]) {
      expect(tools.has(name), `missing ${name}`).toBe(true);
    }
    expect(tools.get('rollback_execute')?.annotations.destructiveHint).toBe(
      true,
    );
    expect(
      tools.get('pagerduty_acknowledge')?.annotations.destructiveHint,
    ).toBe(false);
    expect(tools.get('slack_post_message')?.annotations.openWorldHint).toBe(
      true,
    );

    const linearResponse = await getJson<{ data: McpTool[] }>(
      '/api/v1/mcp-servers/linear/tools',
    );
    const linearTools = new Map(
      linearResponse.data.map(tool => [tool.name, tool]),
    );
    expect(linearTools.get('save_issue')?.annotations.destructiveHint).toBe(
      true,
    );
    expect(linearTools.get('get_issue')?.annotations.destructiveHint).toBe(
      false,
    );
  });
});
