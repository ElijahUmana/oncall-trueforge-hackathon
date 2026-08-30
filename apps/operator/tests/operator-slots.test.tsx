// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { type ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@truefoundry/trueforge-ui', () => ({
  AgentStepsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageErrorBanner: ({ message }: { message: string }) => (
    <p role="alert">{message}</p>
  ),
  MessageListSkeleton: () => <div>Native loading skeleton</div>,
  OpenUiFenceBlock: ({ content }: { content: string }) => <div>{content}</div>,
  ResumeUnavailable: () => <div>Native resume notice</div>,
  SandboxToolCallCard: ({ name }: { name: string }) => <div>{name}</div>,
  SubAgentCard: ({ agentName }: { agentName: string }) => (
    <div>{agentName}</div>
  ),
  ThreadListEmptyState: ({ message }: { message?: string }) => <div>{message}</div>,
  ToolApprovalBar: ({ toolName }: { toolName: string }) => (
    <div>{toolName}</div>
  ),
  ToolCallCard: ({
    toolName,
    expanded,
    highlightCard,
  }: {
    toolName: string;
    expanded?: boolean;
    highlightCard?: boolean;
  }) => (
    <div data-expanded={expanded} data-highlighted={highlightCard}>
      {toolName}
    </div>
  ),
}));

import {
  OperatorAgentSteps,
  OperatorApprovalBar,
  OperatorEmptySessions,
  OperatorErrorBanner,
  OperatorLoading,
  OperatorOpenUiBlock,
  OperatorReconnect,
  OperatorSandboxCard,
  OperatorSubAgentCard,
  OperatorToolCallCard,
} from '../src/operator-slots';

describe('operator slots', () => {
  it('visually distinguishes the four investigation workers', () => {
    const { rerender } = render(
      <OperatorSubAgentCard
        agentName="log-analyzer"
        instruction="Inspect logs"
        stepCount={1}
        status="running"
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Log evidence')).toBeVisible();

    rerender(
      <OperatorSubAgentCard
        agentName="metrics-analyzer"
        instruction="Inspect metrics"
        stepCount={1}
        status="running"
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Service health')).toBeVisible();

    rerender(
      <OperatorSubAgentCard
        agentName="deploy-investigator"
        instruction="Inspect deploys"
        stepCount={1}
        status="running"
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Deploy history')).toBeVisible();

    rerender(
      <OperatorSubAgentCard
        agentName="code-blame"
        instruction="Inspect code"
        stepCount={1}
        status="running"
        expanded
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('Code change')).toBeVisible();
  });

  it('uses native MCP metadata to distinguish closeout providers', () => {
    render(
      <OperatorToolCallCard
        toolName="save_issue"
        mcpServerName="linear"
        status="success"
      />,
    );

    const providerTool = screen.getByRole('region', {
      name: 'Save Issue: success',
    });
    expect(providerTool).toHaveAttribute('data-tool-provider', 'linear');
    expect(within(providerTool).getByText('Linear follow-up')).toBeVisible();
  });

  it('keeps pending approval requests expanded and highlighted', () => {
    render(
      <OperatorToolCallCard
        toolName="rollback_execute"
        expanded={false}
        approvalSlot={<span>Approve rollback</span>}
      />,
    );

    const tool = screen.getByText('rollback_execute');
    expect(tool).toHaveAttribute('data-expanded', 'true');
    expect(tool).toHaveAttribute('data-highlighted', 'true');
  });

  it('makes human approval pause unmistakable while retaining the native control', () => {
    render(
      <OperatorApprovalBar toolName="rollback_execute" onSelect={vi.fn()} />,
    );

    expect(screen.getByText('Human decision required')).toBeVisible();
    expect(
      screen.getByText(
        'Execution is paused. Review the tool request before allowing or denying it.',
      ),
    ).toBeVisible();
    const approval = screen.getByRole('region', {
      name: 'Human approval required for rollback_execute',
    });
    expect(within(approval).getByText('rollback_execute')).toBeVisible();
  });

  it('labels loading, reconnect, empty, and command-stream states', () => {
    const { rerender } = render(<OperatorLoading />);
    expect(screen.getByRole('status', { name: 'Loading incident record' })).toBeVisible();
    expect(screen.getByText('Native loading skeleton')).toBeVisible();

    rerender(<OperatorReconnect />);
    expect(screen.getByText('Live stream interrupted')).toBeVisible();
    expect(screen.getByText('Native resume notice')).toBeVisible();

    rerender(<OperatorEmptySessions message="No sessions" />);
    expect(screen.getByText('No incident records')).toBeVisible();
    expect(screen.getByText('No sessions')).toBeVisible();

    rerender(
      <OperatorAgentSteps
        toolCount={4}
        thinkingCount={2}
        expanded
        active
        onToggle={vi.fn()}
      >
        <span>Runtime evidence</span>
      </OperatorAgentSteps>,
    );
    expect(
      screen.getByRole('region', {
        name: '4 command operations and 2 analysis steps',
      }),
    ).toHaveAttribute('data-active', 'true');
  });

  it('labels native RCA, sandbox, and failure surfaces', () => {
    const { rerender } = render(<OperatorOpenUiBlock content="RCA timeline" />);
    expect(
      screen.getByRole('region', {
        name: 'Incident analysis and remediation choices',
      }),
    ).toBeVisible();

    rerender(
      <OperatorSandboxCard
        name="shell"
        intent="execute"
        status="success"
        expanded
        onToggle={vi.fn()}
        hasContent
        viewMode="terminal"
        onViewModeChange={vi.fn()}
        resultJson={'{"error":"Sandbox initialization failed"}'}
      />,
    );
    const sandbox = screen.getByRole('region', {
      name: 'Sandbox execution: shell',
    });
    expect(sandbox).toBeVisible();
    expect(sandbox).toHaveAttribute('data-execution-state', 'error');
    expect(screen.getByText('Execution failed')).toBeVisible();

    rerender(
      <OperatorSandboxCard
        name="shell"
        intent="execute"
        status="success"
        expanded
        onToggle={vi.fn()}
        hasContent
        viewMode="terminal"
        onViewModeChange={vi.fn()}
        resultJson={'{"status":"healthy","error":null}'}
      />,
    );
    expect(
      screen.getByRole('region', { name: 'Sandbox execution: shell' }),
    ).toHaveAttribute('data-execution-state', 'success');
    expect(screen.getByText('Isolated execution')).toBeVisible();

    rerender(<OperatorErrorBanner message="Tool connection failed" />);
    expect(screen.getByText('Workflow stopped')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Tool connection failed',
    );
  });
});
