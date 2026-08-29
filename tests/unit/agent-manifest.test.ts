import { describe, expect, test } from 'vitest';

import {
  AGENT_INSTRUCTIONS,
  AGENT_NAME,
  MCP_SERVER_NAME,
  SPECIALIST_PROMPTS,
  buildAgentManifest,
} from '../../agent/definition.mjs';

describe('ONCALL agent manifest', () => {
  test('configures real TrueForge capabilities with explicit mutation approvals', () => {
    const manifest = buildAgentManifest({
      modelName: 'openai/gpt-5.6-sol',
      compactionStyle: 'modern',
    });

    expect(manifest.model).toEqual({
      name: 'openai/gpt-5.6-sol',
      params: {
        max_tokens: 8192,
        parallel_tool_calls: true,
      },
    });
    expect(manifest.mcp_servers).toHaveLength(2);
    const [mcpServer, linearServer] = manifest.mcp_servers;
    expect(mcpServer).toBeDefined();
    expect(mcpServer?.name).toBe(MCP_SERVER_NAME);
    expect(mcpServer?.disable_tools).toContain('jira_create_issue');
    expect(mcpServer?.require_approval_for_tools).toEqual(
      expect.arrayContaining([
        '@destructive',
        'pagerduty_resolve',
        'rollback_execute',
        'slack_post_message',
      ]),
    );
    expect(mcpServer?.require_approval_for_tools).not.toContain(
      'pagerduty_acknowledge',
    );
    expect(mcpServer?.require_approval_for_tools).not.toContain(
      'jira_create_issue',
    );
    expect(linearServer).toMatchObject({
      name: 'linear',
      enable_tools: ['get_workspace', 'list_teams', 'save_issue', 'get_issue'],
      require_approval_for_tools: ['@destructive', 'save_issue'],
    });
    expect(manifest.config).toEqual(
      expect.objectContaining({
        ask_user_questions: { enabled: true },
        dynamic_sub_agents: { enabled: true },
        generative_ui: { enabled: true },
        sandbox: { enabled: true, file_downloads: true },
      }),
    );
    expect(manifest.config.context_management.compaction).toEqual({
      enabled: true,
      trigger: { type: 'input_tokens', value: 50_000 },
    });
  });

  test('requires four sibling investigators with independent deploy attribution', () => {
    expect(Object.keys(SPECIALIST_PROMPTS).sort()).toEqual([
      'code-blame',
      'deploy-investigator',
      'log-analyzer',
      'metrics-analyzer',
    ]);
    expect(AGENT_INSTRUCTIONS).toContain(
      'In one model response, call create_sub_agent exactly four times',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'Code-blame must independently identify the strongest temporal deploy candidate',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'verify code-blame independently identified the same deploy as deploy-investigator',
    );
  });

  test('forbids unsupported and cosmetic remediation claims', () => {
    expect(AGENT_NAME).toBe('oncall-incident-responder');
    expect(AGENT_INSTRUCTIONS).toContain(
      'Do not claim lifecycle hooks or hooks.json',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'rollback_execute executes the approved revert in an isolated Daytona sandbox',
    );
    expect(AGENT_INSTRUCTIONS).toContain('sandbox_stopped must be true');
    expect(AGENT_INSTRUCTIONS).toContain('cleanup_error must be absent');
    expect(AGENT_INSTRUCTIONS).toContain(
      "Trust only its authoritative MCP tool response, never the assistant's narration",
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'success === true and response.exitCode === 0',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'Do not run a second git revert with the native sandbox tool',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'A Linear follow-up is required through the official TrueForge Linear connector',
    );
    expect(AGENT_INSTRUCTIONS).not.toContain('jira_create_issue');
    expect(AGENT_INSTRUCTIONS).toContain('If denied, stop remediation.');
  });
});
