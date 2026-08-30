import { createContext, useContext, useEffect } from 'react';
import {
  AgentStepsCard,
  AssistantMessageBubble,
  ComposerShell,
  MessageErrorBanner,
  MessageListSkeleton,
  OpenUiFenceBlock,
  ResumeUnavailable,
  SandboxToolCallCard,
  SubAgentCard,
  ThreadListEmptyState,
  ThreadListShell,
  ToolApprovalBar,
  ToolCallCard,
  type AgentStepsCardProps,
  type AskUserPromptProps,
  type AssistantMessageBubbleProps,
  type ComposerShellProps,
  type MessageErrorBannerProps,
  type MessageListSkeletonProps,
  type OpenUiFenceBlockProps,
  type ResumeUnavailableProps,
  type SandboxToolCallCardProps,
  type SubAgentCardProps,
  type ThreadListEmptyStateProps,
  type ThreadListShellProps,
  type ToolApprovalBarProps,
  type ToolCallCardProps,
  type WelcomeScreenProps,
  useSlot,
} from '@truefoundry/trueforge-ui';
import {
  approvalAction,
  openUiActions,
  sandboxAction,
  toolActions,
  workerAction,
} from './telemetry-adapters';
import {
  asSpecialistName,
} from './telemetry-adapters';
import {
  incidentTelemetry,
  type SpecialistName,
  type TelemetryAction,
} from './telemetry-store';

const WorkerContext = createContext<SpecialistName | undefined>(undefined);

function useTelemetryActions(actions: readonly (TelemetryAction | undefined)[]) {
  const serialized = JSON.stringify(actions);
  useEffect(() => {
    for (const action of actions) {
      if (action) incidentTelemetry.dispatch(action);
    }
  }, [serialized]);
}

const workerLabels: Record<string, { label: string; index: string }> = {
  'log-analyzer': { label: 'Log evidence', index: '01' },
  'metrics-analyzer': { label: 'Service health', index: '02' },
  'deploy-investigator': { label: 'Deploy history', index: '03' },
  'code-blame': { label: 'Code change', index: '04' },
};

const providerLabels: Record<string, string> = {
  slack: 'Slack closeout',
  linear: 'Linear follow-up',
  pagerduty: 'PagerDuty resolution',
  github: 'GitHub verification',
};

function providerForTool(toolName: string, mcpServerName?: string): string | undefined {
  const normalized = `${mcpServerName ?? ''} ${toolName}`.toLowerCase();
  return Object.keys(providerLabels).find(provider =>
    normalized.includes(provider),
  );
}

function toolDisplayName(toolName: string): string {
  return toolName
    .replace(/^mcp__[^_]+__/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

export function OperatorWelcome({ className }: WelcomeScreenProps) {
  const standbyWorkers = Object.entries(workerLabels);
  return (
    <section
      className={`operator-welcome ${className ?? ''}`}
      aria-labelledby="operator-welcome-title"
    >
      <header className="readiness-hero">
        <div>
          <p className="operator-eyebrow">Response fabric / ready</p>
          <h2 id="operator-welcome-title">Incident command is standing by.</h2>
          <p>
            Trigger the alert to open one durable operational record. Every
            investigation, decision, approval, and execution stays inside the
            native TrueForge session.
          </p>
        </div>
        <div className="readiness-signal" aria-label="Runbook ready">
          <span aria-hidden="true"><i /></span>
          <strong>READY</strong>
          <small>Awaiting alert</small>
        </div>
      </header>

      <div className="readiness-grid">
        <section className="standby-workers" aria-labelledby="standby-workers-title">
          <header>
            <div>
              <p className="operator-eyebrow">Parallel investigation</p>
              <h3 id="standby-workers-title">Four specialists, one fan-in</h3>
            </div>
            <span>4 configured</span>
          </header>
          <div className="standby-worker-grid">
            {standbyWorkers.map(([name, worker]) => (
              <article key={name} data-worker={name}>
                <span>{worker.index}</span>
                <div>
                  <strong>{worker.label}</strong>
                  <small>{name}</small>
                </div>
                <i>Standing by</i>
              </article>
            ))}
          </div>
          <div className="fan-in-gate">
            <span aria-hidden="true" />
            <div>
              <strong>Correlation gate</strong>
              <small>Workers converge before remediation is proposed</small>
            </div>
          </div>
        </section>

        <aside className="runbook-readiness" aria-label="Runbook capabilities">
          <p className="operator-eyebrow">Control plane</p>
          <h3>Safety before speed.</h3>
          <dl>
            <div><dt>Execution</dt><dd>Isolated sandbox</dd></div>
            <div><dt>Change control</dt><dd>Native human approval</dd></div>
            <div><dt>Evidence</dt><dd>Persisted tool results</dd></div>
            <div><dt>Closeout</dt><dd>Slack · Linear · PagerDuty</dd></div>
          </dl>
        </aside>
      </div>

      <ol className="operator-flow" aria-label="Response workflow">
        <li><span>01</span><div><strong>Investigate</strong><small>Parallel evidence</small></div></li>
        <li><span>02</span><div><strong>Correlate</strong><small>Root cause + options</small></div></li>
        <li><span>03</span><div><strong>Authorize</strong><small>Human interlock</small></div></li>
        <li><span>04</span><div><strong>Execute</strong><small>Sandboxed change</small></div></li>
        <li><span>05</span><div><strong>Verify</strong><small>Recovery proof</small></div></li>
        <li><span>06</span><div><strong>Close</strong><small>Provider updates</small></div></li>
      </ol>
    </section>
  );
}

export function OperatorAssistantMessage(props: AssistantMessageBubbleProps) {
  return (
    <article className="operator-checkpoint">
      <header>
        <span className="checkpoint-mark" aria-hidden="true" />
        <div>
          <p className="operator-eyebrow">Operational checkpoint</p>
          <strong>ONCALL agent update</strong>
        </div>
      </header>
      <AssistantMessageBubble {...props} />
    </article>
  );
}

export function OperatorComposer(props: ComposerShellProps) {
  return (
    <section className="operator-composer" aria-label="Operator command channel">
      <header>
        <div>
          <span className="composer-live" aria-hidden="true" />
          <strong>Operator channel</strong>
        </div>
        <small>{props.isRunning ? 'Agent responding' : 'Native TrueForge control'}</small>
      </header>
      <ComposerShell {...props} />
    </section>
  );
}

export function OperatorThreadList(props: ThreadListShellProps) {
  return (
    <aside className="operator-incident-rail" aria-label="Durable incident archive">
      <div className="incident-rail-label">
        <p className="operator-eyebrow">Incident archive</p>
        <span>Persistent</span>
      </div>
      <ThreadListShell {...props} />
    </aside>
  );
}

export function OperatorSubAgentCard(props: SubAgentCardProps) {
  const specialist = asSpecialistName(props.agentName);
  useTelemetryActions([workerAction(props)]);
  const worker = workerLabels[props.agentName] ?? {
    label: 'Investigation worker',
    index: '•',
  };
  return (
    <section
      className="operator-worker"
      data-worker={props.agentName}
      data-worker-state={props.status}
      aria-label={`${props.agentName}: ${worker.label}`}
    >
      <header className="operator-worker-heading">
        <span className="operator-worker-index" aria-hidden="true">
          {worker.index}
        </span>
        <div>
          <p className="operator-worker-kicker">{worker.label}</p>
          <span className="operator-worker-state">
            {props.status === 'running' ? 'Collecting evidence' : props.status}
          </span>
        </div>
      </header>
      <WorkerContext.Provider value={specialist}>
        <SubAgentCard {...props} />
      </WorkerContext.Provider>
    </section>
  );
}

export function OperatorApprovalBar(props: ToolApprovalBarProps) {
  useTelemetryActions([approvalAction(props)]);
  const decisionMade = props.status != null;
  return (
    <section
      className="operator-approval"
      data-approval-state={props.status?.type ?? 'pending'}
      aria-label={`Human approval required for ${props.toolName}`}
    >
      <div className="operator-approval-heading">
        <span className="approval-lock" aria-hidden="true">
          {decisionMade ? '✓' : '!'}
        </span>
        <div>
          <p className="operator-eyebrow">
            {decisionMade ? 'Decision recorded' : 'Execution interlock' }
          </p>
          <strong>
            {decisionMade ? props.status?.label : 'Human decision required'}
          </strong>
          <p>
            {decisionMade
              ? 'The native TrueForge decision is attached to this operation.'
              : 'Execution is paused. Review the tool request before allowing or denying it.'}
          </p>
        </div>
        {!decisionMade ? <span className="approval-live">Awaiting operator</span> : null}
      </div>
      <ToolApprovalBar {...props} />
    </section>
  );
}

export function OperatorToolCallCard(props: ToolCallCardProps) {
  const worker = useContext(WorkerContext);
  const telemetryKey = `${worker ?? props.mcpServerName ?? 'main'}:${props.toolName}`;
  useTelemetryActions(toolActions(telemetryKey, props, worker));
  const awaitingApproval = props.approvalSlot != null;
  const provider = providerForTool(props.toolName, props.mcpServerName);
  const status = props.status ?? (props.awaiting ? 'running' : undefined);
  return (
    <section
      className="operator-tool"
      data-tool-state={status ?? 'running'}
      data-tool-provider={provider}
      data-awaiting-approval={awaitingApproval || undefined}
      aria-label={`${toolDisplayName(props.toolName)}: ${awaitingApproval ? 'awaiting human approval' : status ?? 'in progress'}`}
    >
      <header className="operator-tool-heading">
        <div>
          <p className="operator-tool-kicker">
            {provider ? providerLabels[provider] : 'Command stream'}
          </p>
          <strong>{toolDisplayName(props.toolName)}</strong>
        </div>
        <span className="operator-tool-status">
          {awaitingApproval
            ? 'Paused'
            : status === 'success'
              ? 'Verified'
              : status === 'error'
                ? 'Failed'
                : 'Executing'}
        </span>
      </header>
      <ToolCallCard
        {...props}
        expanded={awaitingApproval || props.expanded}
        highlightCard={awaitingApproval || props.highlightCard}
      />
    </section>
  );
}

function hasJsonError(resultJson: string | undefined): boolean {
  if (!resultJson) return false;
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) {
      return false;
    }
    const error = parsed.error;
    return error !== null && error !== false && error !== '';
  } catch {
    return false;
  }
}

function hasSandboxError(props: SandboxToolCallCardProps): boolean {
  if (props.exitCode != null && props.exitCode !== 0) return true;
  return (
    props.resultText?.includes('Sandbox initialization failed') === true ||
    hasJsonError(props.resultJson)
  );
}

export function OperatorSandboxCard(props: SandboxToolCallCardProps) {
  useTelemetryActions([sandboxAction(props)]);
  const failed = hasSandboxError(props);
  const status = failed ? 'error' : props.status;
  return (
    <section
      className="operator-sandbox"
      data-execution-state={status}
      aria-label={`Sandbox execution: ${props.name}`}
    >
      <p className="operator-sandbox-kicker">
        {failed ? 'Execution failed' : 'Isolated execution'}
      </p>
      <SandboxToolCallCard {...props} status={status} />
    </section>
  );
}

export function OperatorOpenUiBlock(props: OpenUiFenceBlockProps) {
  useTelemetryActions(openUiActions(props));
  return (
    <section
      className="operator-rca"
      data-streaming={props.isStreaming || undefined}
      aria-label="Incident analysis and remediation choices"
    >
      <header className="operator-rca-heading">
        <div>
          <p className="operator-eyebrow">Decision surface</p>
          <strong>Evidence, root cause, and remediation</strong>
        </div>
        <span>{props.isStreaming ? 'Synthesizing' : 'Analysis ready'}</span>
      </header>
      <OpenUiFenceBlock {...props} />
    </section>
  );
}

export function OperatorAskUser(props: AskUserPromptProps) {
  const NativeAskUserPrompt = useSlot('AskUserPrompt');
  useTelemetryActions([
    {
      type: 'choice',
      status: props.readOnly ? 'answered' : 'pending',
    },
  ]);
  return (
    <section className="operator-decision-deck" aria-label="Remediation decision">
      <header>
        <p className="operator-eyebrow">Remediation decision</p>
        <strong>Select a path before execution approval</strong>
      </header>
      <NativeAskUserPrompt {...props} />
    </section>
  );
}

export function OperatorAgentSteps(props: AgentStepsCardProps) {
  return (
    <section
      className="operator-command-stream"
      data-active={props.active || undefined}
      aria-label={`${props.toolCount} command operations and ${props.thinkingCount} analysis steps`}
    >
      <div className="command-stream-rail" aria-hidden="true" />
      <AgentStepsCard {...props} />
    </section>
  );
}

export function OperatorLoading(props: MessageListSkeletonProps) {
  return (
    <section className="operator-loading" role="status" aria-label="Loading incident record">
      <div className="loading-orbit" aria-hidden="true"><span /></div>
      <p className="operator-eyebrow">Synchronizing command stream</p>
      <strong>Loading the verified incident record</strong>
      <p>Reconnecting to TrueForge events, approvals, and execution evidence.</p>
      <MessageListSkeleton {...props} />
    </section>
  );
}

export function OperatorReconnect(props: ResumeUnavailableProps) {
  return (
    <section className="operator-reconnect" role="status">
      <span className="reconnect-signal" aria-hidden="true" />
      <div>
        <strong>Live stream interrupted</strong>
        <p>The persisted record remains available while live events reconnect.</p>
      </div>
      <ResumeUnavailable {...props} />
    </section>
  );
}

export function OperatorEmptySessions(props: ThreadListEmptyStateProps) {
  return (
    <section className="operator-empty-sessions">
      <span aria-hidden="true">00</span>
      <strong>No incident records</strong>
      <p>The next triggered alert will appear here.</p>
      <ThreadListEmptyState {...props} />
    </section>
  );
}

export function OperatorErrorBanner(props: MessageErrorBannerProps) {
  return (
    <section className="operator-error">
      <span className="error-beacon" aria-hidden="true">!</span>
      <div>
        <p className="operator-eyebrow">Command stream exception</p>
        <strong>Workflow stopped</strong>
        <p>No unverified operation will continue past this point.</p>
        <MessageErrorBanner {...props} />
      </div>
    </section>
  );
}
