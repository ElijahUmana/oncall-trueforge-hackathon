// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@truefoundry/trueforge-ui', () => ({
  MessageErrorBanner: ({ message }: { message: string }) => <p>{message}</p>,
  OpenUiFenceBlock: ({ content }: { content: string }) => <div>{content}</div>,
  SandboxToolCallCard: ({ name }: { name: string }) => <div>{name}</div>,
  SubAgentCard: ({ agentName }: { agentName: string }) => (
    <div>{agentName}</div>
  ),
  ToolApprovalBar: ({ toolName }: { toolName: string }) => (
    <div>{toolName}</div>
  ),
  ToolCallCard: ({ toolName }: { toolName: string }) => <div>{toolName}</div>,
}));

import {
  OperatorApprovalBar,
  OperatorErrorBanner,
  OperatorOpenUiBlock,
  OperatorSandboxCard,
  OperatorSubAgentCard,
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
    expect(screen.getByText('rollback_execute')).toBeVisible();
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

    rerender(<OperatorErrorBanner message="Tool connection failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Workflow stopped');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Tool connection failed',
    );
  });
});
