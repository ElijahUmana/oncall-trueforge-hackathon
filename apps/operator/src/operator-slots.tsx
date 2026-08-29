import {
  MessageErrorBanner,
  OpenUiFenceBlock,
  SandboxToolCallCard,
  SubAgentCard,
  ToolApprovalBar,
  ToolCallCard,
  type MessageErrorBannerProps,
  type OpenUiFenceBlockProps,
  type SandboxToolCallCardProps,
  type SubAgentCardProps,
  type ToolApprovalBarProps,
  type ToolCallCardProps,
  type WelcomeScreenProps,
} from '@truefoundry/trueforge-ui';

const workerLabels: Record<string, string> = {
  'log-analyzer': 'Log evidence',
  'metrics-analyzer': 'Service health',
  'deploy-investigator': 'Deploy history',
  'code-blame': 'Code change',
};

export function OperatorWelcome({ className }: WelcomeScreenProps) {
  return (
    <section
      className={`operator-welcome ${className ?? ''}`}
      aria-labelledby="operator-welcome-title"
    >
      <p className="operator-eyebrow">Incident command</p>
      <h1 id="operator-welcome-title">Ready for the next alert</h1>
      <p>
        Trigger an incident from the command bar. Investigation, evidence,
        approvals, execution, and verification remain visible in this TrueForge
        session.
      </p>
      <div className="operator-flow" aria-label="Response workflow">
        <span>Investigate</span>
        <span>Decide</span>
        <span>Approve</span>
        <span>Verify</span>
      </div>
    </section>
  );
}

export function OperatorSubAgentCard(props: SubAgentCardProps) {
  const workerLabel = workerLabels[props.agentName] ?? 'Investigation worker';
  return (
    <section
      className="operator-worker"
      data-worker={props.agentName}
      aria-label={`${props.agentName}: ${workerLabel}`}
    >
      <p className="operator-worker-kicker">{workerLabel}</p>
      <SubAgentCard {...props} />
    </section>
  );
}

export function OperatorApprovalBar(props: ToolApprovalBarProps) {
  return (
    <section
      className="operator-approval"
      aria-label={`Human approval required for ${props.toolName}`}
    >
      <div className="operator-approval-heading">
        <span aria-hidden="true">!</span>
        <div>
          <strong>Human decision required</strong>
          <p>
            Execution is paused. Review the tool request before allowing or
            denying it.
          </p>
        </div>
      </div>
      <ToolApprovalBar {...props} />
    </section>
  );
}

export function OperatorToolCallCard(props: ToolCallCardProps) {
  return (
    <div className="operator-tool" data-tool-state={props.status ?? 'running'}>
      <ToolCallCard {...props} />
    </div>
  );
}

function hasSandboxError(props: SandboxToolCallCardProps): boolean {
  if (props.exitCode != null && props.exitCode !== 0) return true;
  const output = `${props.resultText ?? ''}\n${props.resultJson ?? ''}`;
  return /Sandbox initialization failed|"error"\s*:/.test(output);
}

export function OperatorSandboxCard(props: SandboxToolCallCardProps) {
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
  return (
    <section
      className="operator-rca"
      aria-label="Incident analysis and remediation choices"
    >
      <OpenUiFenceBlock {...props} />
    </section>
  );
}

export function OperatorErrorBanner(props: MessageErrorBannerProps) {
  return (
    <div role="alert" className="operator-error">
      <strong>Workflow stopped</strong>
      <MessageErrorBanner {...props} />
    </div>
  );
}
