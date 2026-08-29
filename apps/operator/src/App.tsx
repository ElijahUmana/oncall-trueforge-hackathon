import { useCallback, useMemo, useState } from 'react';
import { TrueForgeUI, type SlotOverrides } from '@truefoundry/trueforge-ui';
import { DEFAULT_AGENT_NAME, DEFAULT_INCIDENT_ID, triggerAlert } from './alert';
import {
  OperatorApprovalBar,
  OperatorErrorBanner,
  OperatorOpenUiBlock,
  OperatorSandboxCard,
  OperatorSubAgentCard,
  OperatorToolCallCard,
  OperatorWelcome,
} from './operator-slots';

const agentName = import.meta.env.VITE_ONCALL_AGENT_NAME ?? DEFAULT_AGENT_NAME;
const incidentId =
  import.meta.env.VITE_ONCALL_INCIDENT_ID ?? DEFAULT_INCIDENT_ID;
const baseUrl =
  import.meta.env.VITE_TRUEFORGE_BASE_URL ?? window.location.origin;

const overrides: SlotOverrides = {
  WelcomeScreen: OperatorWelcome,
  SubAgentCard: OperatorSubAgentCard,
  ToolApprovalBar: OperatorApprovalBar,
  ToolCallCard: OperatorToolCallCard,
  SandboxToolCallCard: OperatorSandboxCard,
  OpenUiFenceBlock: OperatorOpenUiBlock,
  MessageErrorBanner: OperatorErrorBanner,
};

type TriggerState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'TrueForge did not accept the alert. Check the harness connection and agent registration.';
}

export default function App() {
  const [triggerState, setTriggerState] = useState<TriggerState>({
    status: 'idle',
  });
  const server = useMemo(
    () => ({
      type: 'trueforge' as const,
      baseUrl,
    }),
    [],
  );

  const onTrigger = useCallback(async () => {
    setTriggerState({ status: 'submitting' });
    try {
      const sessionId = await triggerAlert({
        baseUrl,
        agentName,
        incidentId,
      });
      window.location.assign(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      setTriggerState({ status: 'error', message: getErrorMessage(error) });
    }
  }, []);

  return (
    <main className="operator-shell">
      <header className="incident-command-bar">
        <div className="incident-command-copy">
          <span className="oncall-mark" aria-hidden="true">
            O
          </span>
          <div>
            <p className="operator-eyebrow">ONCALL / TrueForge</p>
            <h1>Incident response console</h1>
          </div>
        </div>
        <div className="incident-trigger-group">
          <div className="incident-target">
            <span>Alert source</span>
            <strong>{incidentId}</strong>
          </div>
          <button
            type="button"
            className="trigger-alert-button"
            onClick={() => void onTrigger()}
            disabled={triggerState.status === 'submitting'}
            aria-describedby="trigger-status"
          >
            <span className="trigger-pulse" aria-hidden="true" />
            {triggerState.status === 'submitting'
              ? 'Opening incident…'
              : 'Trigger alert'}
          </button>
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

      <section
        className="harness-stage"
        aria-label="TrueForge incident session"
      >
        <TrueForgeUI
          server={server}
          layout="sidebar"
          agentConfig={{ mode: 'SingleAgent', name: agentName }}
          withRouter
          routes={{
            paths: {
              root: '/',
              session: '/sessions/:sessionId',
              agent: false,
              settings: false,
            },
          }}
          overrides={overrides}
          theme={{
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
          }}
          onError={error =>
            setTriggerState({
              status: 'error',
              message: getErrorMessage(error),
            })
          }
          className="trueforge-console"
        />
      </section>
    </main>
  );
}
