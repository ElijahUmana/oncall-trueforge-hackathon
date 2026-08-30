import { describe, expect, it } from 'vitest';
import {
  approvalAction,
  asSpecialistName,
  closeoutProviderForTool,
  openUiActions,
  providerForTool,
  sandboxAction,
  toolActions,
  workerAction,
} from '../src/telemetry-adapters';

describe('telemetry slot adapters', () => {
  it('accepts only the four documented specialist names', () => {
    expect(asSpecialistName('log-analyzer')).toBe('log-analyzer');
    expect(asSpecialistName('unknown-worker')).toBeUndefined();
    expect(
      workerAction({
        agentName: 'unknown-worker',
        status: 'running',
        stepCount: 1,
      }),
    ).toBeUndefined();
  });

  it('maps observable worker props without reading instructions or thoughts', () => {
    expect(
      workerAction({
        agentName: 'metrics-analyzer',
        status: 'success',
        stepCount: 3,
        durationText: '4.2s',
      }),
    ).toEqual({
      type: 'worker',
      name: 'metrics-analyzer',
      status: 'success',
      stepCount: 3,
      elapsedText: '4.2s',
    });
  });

  it('maps tools and closeout providers from public names only', () => {
    expect(providerForTool('logs_query', 'checkout-svc-sim')).toBe(
      'checkout-svc-sim',
    );
    expect(providerForTool('git_show')).toBe('github');
    expect(closeoutProviderForTool('slack_post_message')).toBe('slack');
    expect(closeoutProviderForTool('save_issue', 'linear')).toBe('linear');
    expect(closeoutProviderForTool('pagerduty_resolve')).toBe('pagerduty');

    expect(
      toolActions('slack-1', {
        toolName: 'slack_post_message',
        status: 'success',
        mcpServerName: 'checkout-svc-sim',
      }),
    ).toEqual([
      {
        type: 'tool',
        key: 'slack-1',
        name: 'slack_post_message',
        status: 'success',
        provider: 'checkout-svc-sim',
      },
      { type: 'closeout', provider: 'slack', status: 'success' },
    ]);
  });

  it('maps approval status from authoritative native props', () => {
    expect(approvalAction({ toolName: 'rollback_execute' })).toEqual({
      type: 'approval',
      toolName: 'rollback_execute',
      status: 'pending',
    });
    expect(
      approvalAction({
        toolName: 'rollback_execute',
        status: { type: 'approved', label: 'Allowed' },
      }),
    ).toMatchObject({ status: 'allowed' });
    expect(
      approvalAction({
        toolName: 'rollback_execute',
        status: { type: 'denied', reason: 'blast radius' },
      }),
    ).toMatchObject({ status: 'denied', reason: 'blast radius' });
  });

  it('maps sandbox result and exit code without interpreting narration', () => {
    expect(
      sandboxAction({
        name: 'daytona',
        status: 'success',
        exitCode: 0,
        resultText: '25 requests, 0 errors',
      }),
    ).toEqual({
      type: 'sandbox',
      name: 'daytona',
      status: 'success',
      exitCode: 0,
      resultSummary: '25 requests, 0 errors',
    });
  });

  it('marks OpenUI streaming and readiness without claiming correlation', () => {
    expect(openUiActions({ isStreaming: true })).toEqual([
      { type: 'openui', status: 'streaming' },
    ]);
    expect(openUiActions({ isStreaming: false })).toEqual([
      { type: 'openui', status: 'ready' },
    ]);
  });
});
