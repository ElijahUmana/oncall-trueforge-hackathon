import { useCallback, useState } from 'react';
import {
  getErrorMessage,
  TrueForgeUI,
  type RoutesConfig,
  type SlotOverrides,
  type ThemeConfig,
} from '@truefoundry/trueforge-ui';
import { DEFAULT_AGENT_NAME, DEFAULT_INCIDENT_ID, startAlert } from './alert';
import { createOncallServer } from './oncall-server';
import { ProductionMonitor } from './production-monitor';
import { IncidentCommandCenter } from './incident-command-center';
import { incidentTelemetry, useIncidentTelemetry } from './telemetry-store';
import { TelemetryReplayBridge } from './telemetry-replay';
import {
  OperatorAgentSteps,
  OperatorApprovalBar,
  OperatorAskUser,
  OperatorAssistantMessage,
  OperatorComposer,
  OperatorEmptySessions,
  OperatorErrorBanner,
  OperatorLoading,
  OperatorOpenUiBlock,
  OperatorReconnect,
  OperatorSandboxCard,
  OperatorSubAgentCard,
  OperatorThreadList,
  OperatorToolCallCard,
  OperatorWelcome,
} from './operator-slots';

const agentName = import.meta.env.VITE_ONCALL_AGENT_NAME ?? DEFAULT_AGENT_NAME;
const agentId = import.meta.env.VITE_ONCALL_AGENT_ID;
if (!agentId) {
  throw new Error('VITE_ONCALL_AGENT_ID is required for saved incident history');
}
const incidentId =
  import.meta.env.VITE_ONCALL_INCIDENT_ID ?? DEFAULT_INCIDENT_ID;
const baseUrl =
  import.meta.env.VITE_TRUEFORGE_BASE_URL ?? window.location.origin;

const overrides: SlotOverrides = {
  WelcomeScreen: OperatorWelcome,
  AssistantMessageBubble: OperatorAssistantMessage,
  ComposerShell: OperatorComposer,
  ThreadListShell: OperatorThreadList,
  AgentStepsCard: OperatorAgentSteps,
  SubAgentCard: OperatorSubAgentCard,
  ToolApprovalBar: OperatorApprovalBar,
  AskUserPrompt: OperatorAskUser,
  ToolCallCard: OperatorToolCallCard,
  SandboxToolCallCard: OperatorSandboxCard,
  OpenUiFenceBlock: OperatorOpenUiBlock,
  MessageErrorBanner: OperatorErrorBanner,
  MessageListSkeleton: OperatorLoading,
  ResumeUnavailable: OperatorReconnect,
  ThreadListEmptyState: OperatorEmptySessions,
};

const server = createOncallServer({ baseUrl, agentId });

const agentConfig = { mode: 'SingleAgent' as const, name: agentName };

const routes: RoutesConfig = {
  paths: {
    root: '/workbench',
    session: '/workbench/:sessionId',
    agent: false,
    settings: false,
  },
};

const theme: ThemeConfig = {
  preset: 'trueforge',
  mode: 'dark',
  brand: { name: 'ONCALL' },
  tokens: {
    primaryBg: '#08110e',
    secondaryBg: '#0d1814',
    sidebarBg: '#07100d',
    topbarBg: '#0b1512',
    cardBg: '#101d18',
    textPrimary: '#f2f7f4',
    textSecondary: '#9aaba2',
    border: '#25372f',
    primaryButtonBg: '#f3c969',
    primaryButtonHover: '#ffda7f',
    primaryButtonText: '#171307',
    failureBg: '#ff6b5f',
    radius: '0.6rem',
  },
  classNames: {
    markdown: 'operator-markdown',
    openui: {
      root: 'operator-openui-root',
      scope: 'operator-openui-scope',
    },
  },
};

const errorFallback =
  'TrueForge did not accept the alert. Check the harness connection and agent registration.';

type TriggerState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string };

export default function App() {
  const [triggerState, setTriggerState] = useState<TriggerState>({
    status: 'idle',
  });
  useIncidentTelemetry();
  const workbenchMatch = /^\/workbench(?:\/([^/]+))?$/.exec(
    window.location.pathname,
  );
  const isWorkbenchRoute = workbenchMatch !== null;
  const isSessionRoute = /^\/sessions\/[^/]+$/.test(window.location.pathname);

  const onError = useCallback((error: unknown) => {
    incidentTelemetry.dispatch({ type: 'connection', status: 'interrupted' });
    setTriggerState({
      status: 'error',
      message: getErrorMessage(error, errorFallback),
    });
  }, []);

  const onTrigger = useCallback(async () => {
    incidentTelemetry.dispatch({ type: 'reset' });
    incidentTelemetry.dispatch({ type: 'connection', status: 'live' });
    incidentTelemetry.dispatch({ type: 'sdk-trigger', status: 'running' });
    setTriggerState({ status: 'submitting' });
    try {
      const { sessionId, turn } = await startAlert({
        baseUrl,
        agentName,
        incidentId,
      });
      void turn.catch(error => {
        console.error('TrueForge turn stream ended; session replay will continue.', error);
      });
      incidentTelemetry.dispatch({
        type: 'session',
        sessionId,
        replay: false,
      });
      incidentTelemetry.dispatch({
        type: 'sdk-trigger',
        status: 'success',
        sessionId,
      });
      window.location.assign(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      onError(error);
    }
  }, [onError]);

  if (isWorkbenchRoute) {
    return (
      <main className="workbench-page">
        <header className="workbench-page-header">
          <a
            href={
              workbenchMatch?.[1]
                ? `/sessions/${encodeURIComponent(workbenchMatch[1])}`
                : '/'
            }
          >
            ← Return to incident command
          </a>
          <div>
            <p className="operator-eyebrow">Native TrueForge control</p>
            <h1>Operator workbench</h1>
          </div>
        </header>
        <section className="workbench-page-stage" aria-label="TrueForge workbench">
          <TrueForgeUI
            server={server}
            layout="sidebar"
            agentConfig={agentConfig}
            withRouter
            routes={routes}
            overrides={overrides}
            theme={theme}
            onError={onError}
            className="trueforge-console"
          />
        </section>
      </main>
    );
  }

  if (!isSessionRoute) {
    return <ProductionMonitor />;
  }

  return (
    <main className="operator-shell">
      <TelemetryReplayBridge baseUrl={baseUrl} />
      <header className="incident-command-bar">
        <div className="incident-command-copy">
          <span className="oncall-mark" aria-hidden="true">
            <i />
            O
          </span>
          <div>
            <p className="operator-eyebrow">TrueForge / Autonomous response</p>
            <h1>ONCALL Command</h1>
          </div>
        </div>

        <div className="command-telemetry" aria-label="Runbook safeguards">
          <div>
            <span className="telemetry-dot" aria-hidden="true" />
            <small>Runtime</small>
            <strong>TrueForge</strong>
          </div>
          <div>
            <small>Response fabric</small>
            <strong>4 specialists</strong>
          </div>
          <div>
            <small>Control</small>
            <strong>Approval-gated</strong>
          </div>
        </div>

        <div className="incident-header-status">
          <span className="telemetry-dot" aria-hidden="true" />
          <div>
            <small>Local harness</small>
            <strong>Connected</strong>
          </div>
        </div>
      </header>

      <div
        id="trigger-status"
        className="trigger-status"
        aria-live="polite"
        aria-atomic="true"
      >
        {triggerState.status === 'submitting'
          ? 'Creating a TrueForge session and starting the runbook.'
          : null}
        {triggerState.status === 'error' ? triggerState.message : null}
      </div>

      <IncidentCommandCenter
        incidentId={incidentId}
        isSubmitting={triggerState.status === 'submitting'}
        isSessionRoute={isSessionRoute}
        onEngage={() => void onTrigger()}
      />
    </main>
  );
}
