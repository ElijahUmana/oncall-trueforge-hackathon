import { describe, expect, it, vi } from 'vitest';
import {
  createInitialTelemetry,
  createTelemetryStore,
  reduceTelemetry,
  SPECIALIST_NAMES,
} from '../src/telemetry-store';

describe('incident telemetry', () => {
  it('starts with four idle observable specialist lanes', () => {
    const state = createInitialTelemetry();

    expect(Object.keys(state.workers)).toEqual(SPECIALIST_NAMES);
    expect(Object.values(state.workers)).toEqual(
      SPECIALIST_NAMES.map(name => ({
        name,
        status: 'idle',
        stepCount: 0,
        evidenceCount: 0,
      })),
    );
    expect(state.phase).toBe('standby');
  });

  it('tracks parallel worker lifecycle and elapsed steps', () => {
    let state = createInitialTelemetry();
    SPECIALIST_NAMES.forEach((name, index) => {
      state = reduceTelemetry(state, {
        type: 'worker',
        name,
        status: 'running',
        stepCount: index + 1,
        elapsedText: `${index + 1}s`,
      });
    });

    expect(state.phase).toBe('investigating');
    expect(state.workers['log-analyzer']).toMatchObject({
      status: 'running',
      stepCount: 1,
      elapsedText: '1s',
    });
    expect(
      Object.values(state.workers).every(x => x.status === 'running'),
    ).toBe(true);
  });

  it('tracks active and last tools with idempotent evidence counts', () => {
    let state = reduceTelemetry(createInitialTelemetry(), {
      type: 'tool',
      key: 'logs-1',
      name: 'logs_query',
      status: 'running',
      provider: 'checkout-svc-sim',
      worker: 'log-analyzer',
    });
    expect(state.workers['log-analyzer'].activeTool).toBe('logs_query');

    state = reduceTelemetry(state, {
      type: 'tool',
      key: 'logs-1',
      name: 'logs_query',
      status: 'success',
      provider: 'checkout-svc-sim',
      worker: 'log-analyzer',
      evidenceSnippet: 'CheckoutDeadlineExceeded at 14:32',
    });
    expect(state.workers['log-analyzer']).toMatchObject({
      activeTool: undefined,
      lastTool: 'logs_query',
      evidenceCount: 1,
      evidenceSnippet: 'CheckoutDeadlineExceeded at 14:32',
    });

    const replayed = reduceTelemetry(state, {
      type: 'tool',
      key: 'logs-1',
      name: 'logs_query',
      status: 'success',
      provider: 'checkout-svc-sim',
      worker: 'log-analyzer',
      evidenceSnippet: 'CheckoutDeadlineExceeded at 14:32',
    });
    expect(replayed.workers['log-analyzer'].evidenceCount).toBe(1);
  });

  it('derives fan-in, decision, approval, execution, verification, and closeout phases', () => {
    let state = reduceTelemetry(createInitialTelemetry(), {
      type: 'fan-in',
      status: 'ready',
    });
    expect(state.phase).toBe('correlating');

    state = reduceTelemetry(state, { type: 'openui', status: 'ready' });
    state = reduceTelemetry(state, { type: 'choice', status: 'pending' });
    expect(state.phase).toBe('deciding');

    state = reduceTelemetry(state, {
      type: 'approval',
      toolName: 'rollback_execute',
      status: 'pending',
      target: 'oncall-demo-svc/main',
    });
    expect(state.phase).toBe('awaiting-approval');

    state = reduceTelemetry(state, {
      type: 'approval',
      toolName: 'rollback_execute',
      status: 'allowed',
    });
    state = reduceTelemetry(state, {
      type: 'sandbox',
      status: 'running',
      name: 'daytona',
    });
    expect(state.phase).toBe('executing');

    state = reduceTelemetry(state, {
      type: 'sandbox',
      status: 'success',
      name: 'daytona',
      exitCode: 0,
      resultSummary: '25 requests, 0 errors, p99 122.4ms',
    });
    expect(state.phase).toBe('verifying');

    state = reduceTelemetry(state, {
      type: 'closeout',
      provider: 'slack',
      status: 'success',
      reference: 'C0BT5RBM9UP',
    });
    expect(state.phase).toBe('closing');

    state = reduceTelemetry(state, {
      type: 'closeout',
      provider: 'pagerduty',
      status: 'success',
      reference: 'INC-4821',
    });
    expect(state.phase).toBe('resolved');
  });

  it('treats observable failures and reconnect state as authoritative', () => {
    let state = reduceTelemetry(createInitialTelemetry(), {
      type: 'connection',
      status: 'interrupted',
    });
    expect(state.phase).toBe('reconnecting');

    state = reduceTelemetry(state, { type: 'connection', status: 'live' });
    state = reduceTelemetry(state, {
      type: 'worker',
      name: 'metrics-analyzer',
      status: 'error',
    });
    expect(state.phase).toBe('failed');
  });

  it('tracks replay, skill, saved agent, offloaded evidence, and SDK trigger provenance', () => {
    let state = reduceTelemetry(createInitialTelemetry(), {
      type: 'session',
      sessionId: 'session-1',
      replay: true,
    });
    state = reduceTelemetry(state, {
      type: 'skill',
      status: 'success',
      name: 'oncall-runbook',
      reference: 'commit-1',
    });
    state = reduceTelemetry(state, {
      type: 'saved-agent',
      status: 'success',
      name: 'oncall-incident-responder',
      id: 'agent-1',
    });
    state = reduceTelemetry(state, {
      type: 'offloaded-evidence',
      path: '/evidence/logs.json',
    });
    state = reduceTelemetry(state, {
      type: 'offloaded-evidence',
      path: '/evidence/logs.json',
    });
    state = reduceTelemetry(state, {
      type: 'sdk-trigger',
      status: 'success',
      sessionId: 'session-1',
    });

    expect(state).toMatchObject({
      sessionId: 'session-1',
      replay: true,
      skill: { status: 'success', name: 'oncall-runbook' },
      savedAgent: {
        status: 'success',
        name: 'oncall-incident-responder',
        id: 'agent-1',
      },
      sdkTrigger: { status: 'success', sessionId: 'session-1' },
    });
    expect(state.offloadedEvidence).toEqual(['/evidence/logs.json']);
  });

  it('does not notify subscribers for no-op or duplicate actions', () => {
    const store = createTelemetryStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ type: 'connection', status: 'connecting' });
    expect(listener).not.toHaveBeenCalled();

    store.dispatch({ type: 'connection', status: 'live' });
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispatch({ type: 'connection', status: 'live' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
