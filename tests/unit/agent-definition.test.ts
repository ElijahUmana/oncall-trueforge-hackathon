import { describe, expect, it } from 'vitest';

import {
  AGENT_INSTRUCTIONS,
  DEFAULT_MODEL_NAME,
  SPECIALIST_PROMPTS,
  buildCreateAgentRequest,
} from '../../agent/definition.mjs';

const gatedTools = ['rollback_execute'];

describe('ONCALL TrueForge manifest', () => {
  it.each(['stable', 'modern'] as const)(
    'builds the %s live compaction schema',
    compactionStyle => {
      const request = buildCreateAgentRequest({
        modelName: 'anthropic/claude-sonnet-4-6',
        compactionStyle,
      });
      expect(request.name).toBe('oncall-incident-responder');
      expect(request.manifest.config.context_management.compaction).toEqual(
        compactionStyle === 'modern'
          ? { enabled: true, trigger: { type: 'input_tokens', value: 50_000 } }
          : { enabled: true, compaction_threshold_tokens: 50_000 },
      );
    },
  );

  it('defaults the final agent to the verified OpenAI model', () => {
    expect(DEFAULT_MODEL_NAME).toBe('openai/gpt-5.6-sol');
    expect(buildCreateAgentRequest().manifest.model.name).toBe(
      'openai/gpt-5.6-sol',
    );
  });

  it('enables native harness surfaces and attaches the git-backed skill by name', () => {
    const manifest = buildCreateAgentRequest({
      modelName: 'custom/oncall-model',
    }).manifest;
    expect(manifest.skills).toEqual([{ name: 'oncall-runbook' }]);
    expect(manifest.config).toMatchObject({
      sandbox: { enabled: true, file_downloads: true },
      dynamic_sub_agents: { enabled: true },
      generative_ui: { enabled: true },
      ask_user_questions: { enabled: true },
      context_management: { large_tool_response: { enabled: true } },
    });
  });

  it('gates only rollback execution while allowing acknowledgment and closeout', () => {
    const manifest = buildCreateAgentRequest({
      modelName: 'custom/oncall-model',
    }).manifest;
    const [server, linearServer] = manifest.mcp_servers;
    expect(server).toBeDefined();
    const policy = server?.require_approval_for_tools ?? [];
    expect(server?.disable_tools).toContain('jira_create_issue');
    expect(policy).not.toContain('@destructive');
    expect(policy).not.toContain('@write');
    expect(policy).not.toContain('pagerduty_acknowledge');
    expect(policy).not.toContain('pagerduty_resolve');
    expect(policy).not.toContain('slack_post_message');
    expect(policy).not.toContain('jira_create_issue');
    expect(linearServer).toMatchObject({
      name: 'linear',
      enable_tools: ['get_workspace', 'list_teams', 'save_issue', 'get_issue'],
      require_approval_for_tools: [],
    });
    expect(policy).toEqual(expect.arrayContaining(gatedTools));
  });

  it('requests only metrics exposed by the incident connector', () => {
    expect(SPECIALIST_PROMPTS['metrics-analyzer']).toContain(
      'db_round_trips_p99',
    );
    expect(SPECIALIST_PROMPTS['metrics-analyzer']).not.toContain(
      'db_pool_waiters',
    );
  });

  it('requires sibling fan-out, fan-in, correlation, separate selection and approval', () => {
    expect(AGENT_INSTRUCTIONS).toContain(
      'call create_sub_agent exactly four times',
    );
    expect(AGENT_INSTRUCTIONS).toContain('These calls must be siblings');
    expect(AGENT_INSTRUCTIONS).toContain(
      'Wait for all four thread.done results',
    );
    expect(AGENT_INSTRUCTIONS).toContain('within 120 seconds');
    expect(AGENT_INSTRUCTIONS).toContain('A choice is not execution approval');
  });

  it('uses one approval-gated Daytona execution with typed verification', () => {
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
    expect(AGENT_INSTRUCTIONS).toContain('tests_passed must be true');
    expect(AGENT_INSTRUCTIONS).toContain(
      'revert_sha and remote_sha must be identical full Git SHAs',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'pre_evidence must reproduce the degraded incident',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'post_evidence must show healthy recovery',
    );
  });

  it('requires verified Linear without retaining Jira in the final path', () => {
    expect(AGENT_INSTRUCTIONS).toContain(
      'Create the required Linear follow-up through the official TrueForge Linear connector',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'Create the required Linear follow-up through the official TrueForge Linear connector by calling save_issue exactly once',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'Then call get_issue exactly once with the returned issue ID or identifier',
    );
    expect(AGENT_INSTRUCTIONS).toContain(
      'After verified rollback, complete closeout automatically without additional human approval',
    );
    expect(AGENT_INSTRUCTIONS).not.toContain('jira_create_issue');
  });

  it('does not represent unsupported hooks or direct file import as native capabilities', () => {
    expect(AGENT_INSTRUCTIONS).toContain(
      'Do not claim lifecycle hooks or hooks.json',
    );
    expect(
      JSON.stringify(
        buildCreateAgentRequest({ modelName: 'custom/oncall-model' }),
      ),
    ).not.toContain('timeout_seconds');
  });

  it.each(Object.entries(SPECIALIST_PROMPTS))(
    '%s prompt carries an exact typed contract and anti-fabrication rule',
    (_role, prompt) => {
      expect(prompt).toContain('emit exactly one bare JSON object');
      expect(prompt).toContain(
        'Your first emitted character must be { and your last emitted character must be }',
      );
      expect(prompt).toContain(
        'Do not narrate, announce completion, summarize, add markdown, or add a code fence',
      );
      expect(prompt).toContain('contract_version');
      expect(prompt).toContain('evidence');
      expect(prompt).toContain('unknowns');
      expect(prompt).toContain('never guess');
    },
  );
});
