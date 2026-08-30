import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import {
  SPECIALIST_NAMES,
  type IncidentTelemetry,
  type SpecialistName,
  type TelemetryStatus,
  useIncidentTelemetry,
} from './telemetry-store';

const workerCopy: Record<
  SpecialistName,
  { index: string; label: string; mission: string }
> = {
  'log-analyzer': {
    index: '01',
    label: 'Log analyzer',
    mission: 'Trace the first failing request',
  },
  'metrics-analyzer': {
    index: '02',
    label: 'Metrics analyzer',
    mission: 'Measure the production impact',
  },
  'deploy-investigator': {
    index: '03',
    label: 'Deploy investigator',
    mission: 'Find the triggering release',
  },
  'code-blame': {
    index: '04',
    label: 'Code investigator',
    mission: 'Attribute the responsible change',
  },
};

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

function workerState(status: TelemetryStatus): string {
  if (status === 'running') return 'Investigating';
  if (status === 'success') return 'Report delivered';
  if (status === 'error') return 'Blocked';
  if (status === 'unavailable') return 'Evidence unavailable';
  return 'Waiting for dispatch';
}

function RuntimeProof({ children }: { children: string }) {
  return (
    <div className="scene-runtime-proof">
      <span aria-hidden="true" />
      {children}
    </div>
  );
}

function IgnitionScene({
  incidentId,
  isSubmitting,
  onEngage,
  liveActions,
}: {
  incidentId: string;
  isSubmitting: boolean;
  onEngage: () => void;
  liveActions?: string[];
}) {
  if (isSubmitting) {
    return (
      <section className="story-scene dispatch-scene" aria-live="polite">
        <div className="dispatch-orbit" aria-hidden="true">
          <span />
          <span />
          <i>O</i>
        </div>
        <p className="scene-kicker">TrueForge session dispatch</p>
        <h2>ONCALL is on the incident.</h2>
        <p>
          The durable session is live. ONCALL is acknowledging the page and
          waking four isolated specialists.
        </p>
        <div className="dispatch-workers" aria-label="Specialists being paged">
          {SPECIALIST_NAMES.map((name, index) => (
            <span key={name} style={{ '--dispatch-index': index } as CSSProperties}>
              {workerCopy[name].label}
            </span>
          ))}
        </div>
        {liveActions && liveActions.length > 0 ? (
          <ul className="dispatch-action-feed" aria-label="Live harness activity">
            {liveActions.map(action => (
              <li key={action}>
                <span aria-hidden="true" />
                {readable(action)}
              </li>
            ))}
          </ul>
        ) : null}
        <RuntimeProof>SDK trigger · persistent session · SSE handoff</RuntimeProof>
      </section>
    );
  }

  return (
    <section className="story-scene ignition-scene">
      <div className="page-signal" aria-hidden="true">
        <span />
        <i />
      </div>
      <div className="ignition-copy">
        <p className="scene-kicker">Incoming production page</p>
        <h2>Production alert received.</h2>
        <p className="ignition-summary">
          A new incident is waiting for autonomous investigation. No production
          action has been taken.
        </p>
      </div>
      <dl className="incoming-incident-facts">
        <div>
          <dt>Incident</dt>
          <dd>{incidentId}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>Incident connector</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>Not collected</dd>
        </div>
      </dl>
      <button
        type="button"
        className="engage-oncall-button"
        onClick={onEngage}
      >
        <span aria-hidden="true">→</span>
        <span>
          <small>Start autonomous response</small>
          Engage ONCALL
        </span>
      </button>
      <RuntimeProof>
        Four specialists ready · writes require human approval
      </RuntimeProof>
    </section>
  );
}

function WorkerTerminal({
  name,
  telemetry,
}: {
  name: SpecialistName;
  telemetry: IncidentTelemetry;
}) {
  const worker = telemetry.workers[name];
  const copy = workerCopy[name];
  const operation = worker.activeTool ?? worker.lastTool;
  const workerTools = Object.values(telemetry.tools)
    .filter(tool => tool.worker === name)
    .slice(-4)
    .reverse();
  return (
    <article
      className="agent-terminal"
      data-worker={name}
      data-status={worker.status}
      aria-label={`${copy.label}: ${workerState(worker.status)}`}
    >
      <header>
        <span>{copy.index}</span>
        <div>
          <strong>{copy.label}</strong>
          <small>{copy.mission}</small>
        </div>
        <i>{workerState(worker.status)}</i>
      </header>
      <div className="terminal-stream" aria-hidden="true">
        <span />
      </div>
      <div className="terminal-operation">
        <small>Current operation</small>
        <strong>{operation ? readable(operation) : 'Awaiting worker event'}</strong>
      </div>
      <ol className="terminal-tool-trace" aria-label={`${copy.label} tool activity`}>
        {workerTools.length > 0 ? (
          workerTools.map(tool => (
            <li key={tool.key} data-status={tool.status}>
              <span />
              <div>
                <strong>{readable(tool.name)}</strong>
                <small>
                  {tool.evidenceSnippet ??
                    (tool.status === 'running' ? 'Collecting evidence…' : readable(tool.status))}
                </small>
              </div>
            </li>
          ))
        ) : (
          <li data-status="running">
            <span />
            <div>
              <strong>Booting isolated context</strong>
              <small>Runbook and tool bindings loading…</small>
            </div>
          </li>
        )}
      </ol>
      <div className="terminal-evidence">
        <span>{worker.evidenceCount}</span>
        <div>
          <small>Verified evidence</small>
          <p>{worker.evidenceSnippet ?? 'No report delivered yet.'}</p>
        </div>
      </div>
    </article>
  );
}

function InvestigationScene({ telemetry }: { telemetry: IncidentTelemetry }) {
  const workers = Object.values(telemetry.workers);
  const completed = workers.filter(worker => worker.status === 'success').length;
  const active = workers.filter(worker => worker.status === 'running').length;
  return (
    <section
      className="story-scene investigation-scene"
      data-proof-surface="dynamic-subagents"
    >
      <header className="scene-heading">
        <div>
          <p className="scene-kicker">TrueForge dynamic subagents</p>
          <h2>Four investigations are running in parallel.</h2>
        </div>
        <div className="parallel-counter">
          <strong>{active}</strong>
          <span>live now</span>
        </div>
      </header>
      <div className="agent-terminal-grid">
        {SPECIALIST_NAMES.map(name => (
          <WorkerTerminal key={name} name={name} telemetry={telemetry} />
        ))}
      </div>
      <div className="fan-in-progress">
        <div>
          <span style={{ width: `${(completed / SPECIALIST_NAMES.length) * 100}%` }} />
        </div>
        <strong>{completed}/4 typed reports delivered</strong>
        <small>Correlation remains locked until every specialist finishes.</small>
      </div>
      <RuntimeProof>Sibling threads · MCP tools · typed evidence contracts</RuntimeProof>
    </section>
  );
}

function CorrelationScene({ telemetry }: { telemetry: IncidentTelemetry }) {
  return (
    <section
      className="story-scene correlation-scene"
      data-proof-surface="fan-in"
      data-state={telemetry.fanIn}
    >
      <header className="scene-heading">
        <div>
          <p className="scene-kicker">Evidence fan-in</p>
          <h2>The four reports are converging.</h2>
        </div>
      </header>
      <div className="evidence-convergence">
        <div className="evidence-report-stack">
          {SPECIALIST_NAMES.map(name => {
            const worker = telemetry.workers[name];
            return (
              <article key={name} data-worker={name}>
                <span>{workerCopy[name].index}</span>
                <div>
                  <strong>{workerCopy[name].label}</strong>
                  <p>{worker.evidenceSnippet ?? 'Typed report received'}</p>
                </div>
              </article>
            );
          })}
        </div>
        <div className="convergence-core" aria-live="polite">
          <span aria-hidden="true" />
          <small>Correlation gate</small>
          <strong>
            {telemetry.fanIn === 'correlated'
              ? 'Evidence agrees'
              : 'Validating typed reports'}
          </strong>
          <p>
            {telemetry.fanIn === 'correlated'
              ? 'Root-cause analysis is ready for an operator decision.'
              : 'No remediation is proposed until the reports form one causal chain.'}
          </p>
        </div>
      </div>
      <RuntimeProof>Fan-in gate · OpenUI synthesis · evidence-linked RCA</RuntimeProof>
    </section>
  );
}

function DecisionScene({
  telemetry,
  demo,
}: {
  telemetry: IncidentTelemetry;
  demo: DemoRecoveryState;
}) {
  const approval = telemetry.approval;
  const awaitingApproval =
    demo.phase === 'approval' || approval?.status === 'pending';
  const [submitting, setSubmitting] = useState<string>();
  const [checkpointDetail, setCheckpointDetail] = useState<string>();
  useEffect(() => {
    if (!awaitingApproval) return;
    let active = true;
    void fetch('/demo/state', { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : undefined))
      .then((state: { checkpoint?: { detail?: string } } | undefined) => {
        if (active) setCheckpointDetail(state?.checkpoint?.detail);
      });
    return () => {
      active = false;
    };
  }, [awaitingApproval, approval?.toolCallId]);
  const options = awaitingApproval
    ? ['allow', 'deny']
    : [
        'rollback the suspect deploy',
        'restart the service',
        'provide a manual patch',
        'escalate without action',
      ];
  const respond = async (value: string) => {
    setSubmitting(value);
    try {
      const endpoint = awaitingApproval && value === 'allow'
        ? '/demo/approve-rollback'
        : !awaitingApproval && value === 'rollback the suspect deploy'
          ? '/demo/select-rollback'
          : '/demo/respond';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!response.ok) {
        throw new Error(`ONCALL response failed with HTTP ${response.status}`);
      }
    } finally {
      setSubmitting(undefined);
    }
  };
  return (
    <section
      className="story-scene decision-scene"
      data-proof-surface={awaitingApproval ? 'approval' : 'ask-user'}
    >
      <div className="decision-lock" aria-hidden="true">
        <span>{awaitingApproval ? '!' : '?'}</span>
      </div>
      <p className="scene-kicker">
        {awaitingApproval
          ? 'Step 2 of 2 · the only production approval'
          : 'Step 1 of 2 · remediation selection'}
      </p>
      <h2>
        {awaitingApproval
          ? 'Production execution is paused.'
          : 'The evidence is ready for your decision.'}
      </h2>
      <p className="decision-explanation">
        {awaitingApproval
          ? 'ONCALL cannot cross this boundary until the exact tool request is allowed or denied.'
          : 'Choose the remediation path in the native TrueForge control below.'}
      </p>
      <div className="decision-target">
        <small>{awaitingApproval ? 'Requested operation' : 'Correlated recommendation'}</small>
        <strong>
          {awaitingApproval && approval?.toolName
            ? readable(approval.toolName)
            : 'Rollback deploy 9921'}
        </strong>
        {awaitingApproval && checkpointDetail ? (
          <span>{checkpointDetail}</span>
        ) : approval?.target ? (
          <span>{approval.target}</span>
        ) : null}
      </div>
      <div className="decision-options" aria-label="ONCALL decision controls">
        {options.map(option => (
          <button
            type="button"
            key={option}
            disabled={submitting !== undefined}
            data-primary={option === options[0] || undefined}
            onClick={() => void respond(option)}
          >
            <small>{awaitingApproval ? 'Production interlock' : 'Remediation path'}</small>
            <strong>{submitting === option ? 'Submitting…' : option}</strong>
          </button>
        ))}
      </div>
      <p className="decision-slack-sync">
        The same checkpoint is live in Slack #oncall-demo. First recorded response resumes this TrueForge session.
      </p>
      <RuntimeProof>Native ask-user · exact approval · browser + Slack synchronized</RuntimeProof>
    </section>
  );
}

function condense(value: string, limit = 150): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

type DemoRecoveryState = {
  phase?: string;
  executionStep?: number;
  recovery?: {
    sandboxId: string;
    preP99Ms: number;
    preErrors: number;
    postP99Ms: number;
    postErrors: number;
    revertSha: string;
    remoteSha: string;
    testsPassed: boolean;
    sandboxStopped: boolean;
    githubUrl: string;
    linearUrl: string;
  };
  slackPermalink?: string;
  finalSlackPermalink?: string;
};

function useDemoRecoveryState(): DemoRecoveryState {
  const [state, setState] = useState<DemoRecoveryState>({});
  useEffect(() => {
    let active = true;
    const poll = () => {
      void fetch('/demo/state', { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : undefined))
        .then(value => {
          if (active && value) setState(value as DemoRecoveryState);
        });
    };
    poll();
    const timer = window.setInterval(poll, 800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return state;
}

function ExecutionScene({
  telemetry,
  demo,
}: {
  telemetry: IncidentTelemetry;
  demo: DemoRecoveryState;
}) {
  const demoStep = demo.phase === 'executing' ? demo.executionStep ?? 0 : undefined;
  const running = demo.phase === 'executing' || telemetry.sandbox.status === 'running';
  const repository = telemetry.recovery.repositoryUrl;
  const sandboxName =
    demo.recovery?.sandboxId ??
    telemetry.recovery.sandboxId ??
    (telemetry.sandbox.name && telemetry.sandbox.name !== 'exec'
      ? telemetry.sandbox.name
      : 'Daytona sandbox');
  const resultSummary = telemetry.sandbox.resultSummary;
  return (
    <section
      className="story-scene execution-scene"
      data-proof-surface="daytona"
      data-execution-state={telemetry.sandbox.status}
    >
      <header className="scene-heading">
        <div>
          <p className="scene-kicker">Daytona isolated execution</p>
          <h2>{running ? 'Recovery is executing.' : 'Verifying the result.'}</h2>
        </div>
        <span className="execution-beacon">{running ? 'LIVE' : 'VERIFYING'}</span>
      </header>
      <div className="execution-chamber">
        <div className="sandbox-core">
          <span aria-hidden="true" />
          <small>Sandbox</small>
          <strong>{condense(sandboxName, 28)}</strong>
          <p>
            {condense(
              repository?.replace(/^https?:\/\//, '') ??
                'Approved repository attached to the operation',
              48,
            )}
          </p>
        </div>
        <ol aria-label="Approved recovery pipeline">
          {(
            [
              ['Clone', Boolean(telemetry.recovery.sandboxId), undefined],
              [
                'Reproduce',
                Boolean(telemetry.recovery.pre),
                telemetry.recovery.pre
                  ? `${metric(telemetry.recovery.pre.errors)} errors · p99 ${metric(telemetry.recovery.pre.p99Ms)}ms`
                  : undefined,
              ],
              [
                'Revert',
                Boolean(telemetry.recovery.revertSha),
                telemetry.recovery.revertSha?.slice(0, 10),
              ],
              [
                'Test',
                telemetry.recovery.testsPassed === true,
                telemetry.recovery.testsPassed === true ? 'passed' : undefined,
              ],
              [
                'Push',
                Boolean(telemetry.recovery.remoteSha),
                telemetry.recovery.remoteSha?.slice(0, 10),
              ],
              [
                'Verify',
                Boolean(telemetry.recovery.post),
                telemetry.recovery.post
                  ? `${metric(telemetry.recovery.post.errors)} errors · p99 ${metric(telemetry.recovery.post.p99Ms)}ms`
                  : undefined,
              ],
            ] as Array<[string, boolean, string | undefined]>
          ).map(([step, done, detail], index, steps) => {
            const demoDone = demoStep !== undefined && demoStep > index;
            const demoActive = demoStep !== undefined && demoStep === index;
            const stageDone = done || demoDone;
            const active = demoStep === undefined
              ? running && !done && steps.slice(0, index).every(s => s[1])
              : demoActive;
            return (
              <li
                key={step}
                data-active={active || undefined}
                data-done={stageDone || undefined}
              >
                <span>{stageDone ? '✓' : String(index + 1).padStart(2, '0')}</span>
                <strong>{step}</strong>
                {detail ? <small>{condense(detail, 34)}</small> : null}
              </li>
            );
          })}
        </ol>
      </div>
      {resultSummary ? (
        <p className="execution-result">{condense(resultSummary, 180)}</p>
      ) : null}
      <RuntimeProof>Approved mutation · isolated sandbox · remote verification</RuntimeProof>
    </section>
  );
}

function metric(value: number | undefined, suffix = ''): string {
  return value === undefined ? 'Unavailable' : `${value}${suffix}`;
}

function recoveryVerified(telemetry: IncidentTelemetry): boolean {
  const recovery = telemetry.recovery;
  return Boolean(
    recovery.post &&
      recovery.testsPassed === true &&
      recovery.sandboxStopped === true &&
      recovery.revertSha &&
      recovery.remoteSha === recovery.revertSha,
  );
}

function OutcomeScene({
  telemetry,
  demo,
}: {
  telemetry: IncidentTelemetry;
  demo: DemoRecoveryState;
}) {
  const demoRecovery = demo.recovery;
  const verified = demo.phase === 'recovered' || recoveryVerified(telemetry);
  const providers = [
    ['Slack', telemetry.closeout.slack],
    ['Linear', telemetry.closeout.linear],
    ['PagerDuty', telemetry.closeout.pagerduty],
  ] as const;
  const visibleProviders = providers.filter(([, value]) => value.status !== 'idle');
  return (
    <section
      className="story-scene outcome-scene"
      data-proof-surface="recovery"
      data-recovery-verified={verified || undefined}
    >
      <header className="outcome-heading">
        <div className="recovery-seal" aria-hidden="true">
          {verified ? '✓' : '…'}
        </div>
        <div>
          <p className="scene-kicker">
            {verified ? 'Recovery verified' : 'Provider closeout'}
          </p>
          <h2>
            {verified ? 'Production recovered.' : 'Publishing the incident outcome.'}
          </h2>
        </div>
      </header>
      <div className="recovery-comparison">
        <article data-state="before">
          <small>Before execution</small>
          <strong>{metric(demoRecovery?.preP99Ms ?? telemetry.recovery.pre?.p99Ms, ' ms p99')}</strong>
          <span>{metric(demoRecovery?.preErrors ?? telemetry.recovery.pre?.errors, ' errors')}</span>
        </article>
        <div aria-hidden="true">→</div>
        <article data-state="after">
          <small>After verification</small>
          <strong>{metric(demoRecovery?.postP99Ms ?? telemetry.recovery.post?.p99Ms, ' ms p99')}</strong>
          <span>{metric(demoRecovery?.postErrors ?? telemetry.recovery.post?.errors, ' errors')}</span>
        </article>
      </div>
      <div className="recovery-integrity">
        <div>
          <small>Revert</small>
          <strong>{(demoRecovery?.revertSha ?? telemetry.recovery.revertSha)?.slice(0, 10) ?? 'Unavailable'}</strong>
        </div>
        <div>
          <small>Remote</small>
          <strong>{(demoRecovery?.remoteSha ?? telemetry.recovery.remoteSha)?.slice(0, 10) ?? 'Unavailable'}</strong>
        </div>
        <div>
          <small>Tests</small>
          <strong>{demoRecovery?.testsPassed || telemetry.recovery.testsPassed ? 'Passed' : 'Unavailable'}</strong>
        </div>
        <div>
          <small>Sandbox</small>
          <strong>{demoRecovery?.sandboxStopped || telemetry.recovery.sandboxStopped ? 'Stopped' : 'Unavailable'}</strong>
        </div>
      </div>
      <div
        className="provider-sequence"
        data-proof-surface="provider-closeout"
        aria-label="Approved provider closeout"
      >
        {demoRecovery ? (
          <>
            <a className="provider-artifact" href={demo.finalSlackPermalink ?? demo.slackPermalink} target="_blank" rel="noreferrer">
              <span>✓</span><div><small>Final incident update</small><strong>Slack RCA</strong><p>Open message ↗</p></div>
            </a>
            <a className="provider-artifact" href={demoRecovery.githubUrl} target="_blank" rel="noreferrer">
              <span>✓</span><div><small>Verified recovery commit</small><strong>GitHub rollback</strong><p>{demoRecovery.revertSha.slice(0, 10)} ↗</p></div>
            </a>
            <a className="provider-artifact" href={demoRecovery.linearUrl} target="_blank" rel="noreferrer">
              <span>✓</span><div><small>Permanent guard follow-up</small><strong>Linear ELI-5</strong><p>Open issue ↗</p></div>
            </a>
          </>
        ) : visibleProviders.length > 0 ? (
          visibleProviders.map(([name, value], index) => (
            <article key={name} data-status={value.status}>
              <span>{value.status === 'success' ? '✓' : String(index + 1)}</span>
              <div>
                <small>Approved write</small>
                <strong>{name}</strong>
                <p>{value.reference ?? readable(value.status)}</p>
              </div>
            </article>
          ))
        ) : (
          <p>No provider write has been authorized yet.</p>
        )}
      </div>
      <RuntimeProof>Durable audit · provider approvals · replayable session</RuntimeProof>
    </section>
  );
}

function InterruptedScene({ failed }: { failed: boolean }) {
  return (
    <section className="story-scene interrupted-scene" role="status">
      <span aria-hidden="true">{failed ? '!' : '↻'}</span>
      <p className="scene-kicker">
        {failed ? 'Workflow stopped' : 'Restoring persisted state'}
      </p>
      <h2>{failed ? 'No unverified action will continue.' : 'Reconnecting to TrueForge.'}</h2>
      <p>
        {failed
          ? 'Inspect the native workbench for the authoritative failure and recovery controls.'
          : 'The durable incident record remains intact while the live stream reconnects.'}
      </p>
    </section>
  );
}

export function IncidentCommandCenter({
  incidentId,
  isSubmitting,
  isSessionRoute,
  onEngage,
}: {
  incidentId: string;
  isSubmitting: boolean;
  isSessionRoute: boolean;
  onEngage: () => void;
}) {
  const telemetry = useIncidentTelemetry();
  const demo = useDemoRecoveryState();
  const phase =
    demo.phase === 'executing'
      ? 'executing'
      : demo.phase === 'recovered' && demo.recovery
        ? 'recovered'
        : demo.phase === 'approval'
          ? 'awaiting-approval'
          : demo.phase === 'decision'
            ? 'deciding'
            : telemetry.phase;

  let scene;
  if (phase === 'failed') {
    scene = <InterruptedScene failed />;
  } else if (phase === 'reconnecting') {
    scene = <InterruptedScene failed={false} />;
  } else if (phase === 'investigating') {
    scene = <InvestigationScene telemetry={telemetry} />;
  } else if (phase === 'standby' && isSessionRoute) {
    const starting = { ...telemetry };
    for (const name of SPECIALIST_NAMES) {
      starting.workers = {
        ...starting.workers,
        [name]: {
          ...starting.workers[name],
          status: 'running',
          activeTool: 'starting isolated investigation',
        },
      };
    }
    scene = <InvestigationScene telemetry={starting} />;
  } else if (phase === 'correlating') {
    scene = <CorrelationScene telemetry={telemetry} />;
  } else if (phase === 'deciding' || phase === 'awaiting-approval') {
    scene = <DecisionScene telemetry={telemetry} demo={demo} />;
  } else if (phase === 'executing' || phase === 'verifying') {
    scene = <ExecutionScene telemetry={telemetry} demo={demo} />;
  } else if (
    phase === 'recovered' ||
    phase === 'closing' ||
    phase === 'resolved'
  ) {
    scene = <OutcomeScene telemetry={telemetry} demo={demo} />;
  } else if (isSubmitting || telemetry.sessionId) {
    const liveActions = Object.values(telemetry.tools)
      .filter(tool => !tool.worker)
      .slice(-4)
      .map(tool =>
        tool.status === 'running' ? `${tool.name} · running` : tool.name,
      );
    scene = (
      <IgnitionScene
        incidentId={incidentId}
        isSubmitting
        onEngage={onEngage}
        liveActions={liveActions}
      />
    );
  } else {
    scene = (
      <IgnitionScene
        incidentId={incidentId}
        isSubmitting={false}
        onEngage={onEngage}
      />
    );
  }

  return (
    <section
      className="incident-story"
      data-phase={phase}
      data-session-id={telemetry.sessionId}
    >
      <div className="story-stage">{scene}</div>
    </section>
  );
}
