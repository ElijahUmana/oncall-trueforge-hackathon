import { useSyncExternalStore } from 'react';

export const SPECIALIST_NAMES = [
  'log-analyzer',
  'metrics-analyzer',
  'deploy-investigator',
  'code-blame',
] as const;

export type SpecialistName = (typeof SPECIALIST_NAMES)[number];
export type TelemetryStatus =
  'idle' | 'running' | 'success' | 'error' | 'unavailable';
export type IncidentPhase =
  | 'standby'
  | 'reconnecting'
  | 'investigating'
  | 'correlating'
  | 'deciding'
  | 'awaiting-approval'
  | 'executing'
  | 'verifying'
  | 'recovered'
  | 'closing'
  | 'resolved'
  | 'failed';
export type CloseoutProvider = 'slack' | 'linear' | 'pagerduty';

export type WorkerTelemetry = {
  name: SpecialistName;
  status: TelemetryStatus;
  stepCount: number;
  elapsedText?: string;
  activeTool?: string;
  lastTool?: string;
  lastToolStatus?: TelemetryStatus;
  evidenceCount: number;
  evidenceSnippet?: string;
};

export type ToolTelemetry = {
  key: string;
  name: string;
  status: TelemetryStatus;
  provider?: string;
  worker?: SpecialistName;
  evidenceSnippet?: string;
};

export type ApprovalTelemetry = {
  id?: string;
  toolCallId?: string;
  toolName: string;
  status: 'pending' | 'allowed' | 'denied';
  target?: string;
  reason?: string;
  completedAt?: string;
};

export type IncidentFacts = {
  id?: string;
  service?: string;
  severity?: string;
  status?: string;
  peakP99Ms?: number;
  peakErrorRatePct?: number;
};

export type RecoveryEvidence = {
  repositoryUrl?: string;
  branch?: string;
  sandboxId?: string;
  pre?: {
    requests?: number;
    errors?: number;
    errorRate?: number;
    p99Ms?: number;
  };
  revertSha?: string;
  testsPassed?: boolean;
  post?: {
    requests?: number;
    errors?: number;
    errorRate?: number;
    p99Ms?: number;
  };
  remoteSha?: string;
  sandboxStopped?: boolean;
};

export type IncidentTelemetry = {
  revision: number;
  sessionId?: string;
  replay: boolean;
  connection: 'connecting' | 'live' | 'interrupted';
  phase: IncidentPhase;
  workers: Record<SpecialistName, WorkerTelemetry>;
  tools: Record<string, ToolTelemetry>;
  fanIn: 'waiting' | 'ready' | 'correlated' | 'blocked';
  openUi: 'idle' | 'streaming' | 'ready';
  choice: 'idle' | 'pending' | 'answered';
  incident: IncidentFacts;
  approvals: ApprovalTelemetry[];
  approval?: ApprovalTelemetry;
  recovery: RecoveryEvidence;
  sandbox: {
    status: TelemetryStatus;
    name?: string;
    exitCode?: number | null;
    resultSummary?: string;
  };
  closeout: Record<
    CloseoutProvider,
    { status: TelemetryStatus; reference?: string }
  >;
  skill: { status: TelemetryStatus; name?: string; reference?: string };
  savedAgent: { status: TelemetryStatus; name?: string; id?: string };
  offloadedEvidence: string[];
  sdkTrigger: { status: TelemetryStatus; sessionId?: string };
};

export type TelemetryAction =
  | { type: 'session'; sessionId?: string; replay?: boolean }
  | {
      type: 'connection';
      status: IncidentTelemetry['connection'];
    }
  | {
      type: 'worker';
      name: SpecialistName;
      status: TelemetryStatus;
      stepCount?: number;
      elapsedText?: string;
    }
  | {
      type: 'tool';
      key: string;
      name: string;
      status: TelemetryStatus;
      provider?: string;
      worker?: SpecialistName;
      evidenceSnippet?: string;
    }
  | { type: 'fan-in'; status: IncidentTelemetry['fanIn'] }
  | { type: 'openui'; status: IncidentTelemetry['openUi'] }
  | { type: 'choice'; status: IncidentTelemetry['choice'] }
  | { type: 'incident'; facts: Partial<IncidentFacts> }
  | { type: 'recovery'; evidence: Partial<RecoveryEvidence> }
  | {
      type: 'approval';
      id?: string;
      toolCallId?: string;
      toolName: string;
      status: ApprovalTelemetry['status'];
      target?: string;
      reason?: string;
      completedAt?: string;
    }
  | {
      type: 'sandbox';
      status: TelemetryStatus;
      name?: string;
      exitCode?: number | null;
      resultSummary?: string;
    }
  | {
      type: 'closeout';
      provider: CloseoutProvider;
      status: TelemetryStatus;
      reference?: string;
    }
  | {
      type: 'skill';
      status: TelemetryStatus;
      name?: string;
      reference?: string;
    }
  | {
      type: 'saved-agent';
      status: TelemetryStatus;
      name?: string;
      id?: string;
    }
  | { type: 'offloaded-evidence'; path: string }
  | {
      type: 'sdk-trigger';
      status: TelemetryStatus;
      sessionId?: string;
    }
  | { type: 'reset' };

const initialWorker = (name: SpecialistName): WorkerTelemetry => ({
  name,
  status: 'idle',
  stepCount: 0,
  evidenceCount: 0,
});

export function createInitialTelemetry(): IncidentTelemetry {
  return {
    revision: 0,
    replay: false,
    connection: 'connecting',
    phase: 'standby',
    workers: Object.fromEntries(
      SPECIALIST_NAMES.map(name => [name, initialWorker(name)]),
    ) as Record<SpecialistName, WorkerTelemetry>,
    tools: {},
    fanIn: 'waiting',
    openUi: 'idle',
    choice: 'idle',
    incident: {},
    approvals: [],
    recovery: {},
    sandbox: { status: 'idle' },
    closeout: {
      slack: { status: 'idle' },
      linear: { status: 'idle' },
      pagerduty: { status: 'idle' },
    },
    skill: { status: 'idle' },
    savedAgent: { status: 'idle' },
    offloadedEvidence: [],
    sdkTrigger: { status: 'idle' },
  };
}

function phaseFor(state: IncidentTelemetry): IncidentPhase {
  const hasOperationalState =
    Object.values(state.workers).some(worker => worker.status !== 'idle') ||
    state.fanIn !== 'waiting' ||
    state.choice !== 'idle' ||
    state.approval !== undefined ||
    state.sandbox.status !== 'idle' ||
    state.recovery.post !== undefined ||
    Object.values(state.closeout).some(item => item.status !== 'idle');
  if (state.connection === 'interrupted' && !hasOperationalState && !state.sessionId) {
    return 'reconnecting';
  }
  if (
    Object.values(state.workers).some(worker => worker.status === 'error') ||
    state.sandbox.status === 'error' ||
    Object.values(state.closeout).some(item => item.status === 'error')
  ) {
    return 'failed';
  }
  const rollbackTool = Object.values(state.tools).find(
    tool => tool.name === 'rollback_execute',
  );
  const recoveryVerified =
    state.recovery.post !== undefined &&
    state.recovery.testsPassed === true &&
    state.recovery.revertSha !== undefined &&
    state.recovery.remoteSha === state.recovery.revertSha &&
    state.recovery.sandboxStopped === true;
  if (state.approval?.status === 'pending') return 'awaiting-approval';
  if (state.choice === 'pending') return 'deciding';
  if (rollbackTool?.status === 'error') return 'failed';
  if (
    state.sandbox.status === 'running' ||
    rollbackTool?.status === 'running' ||
    (state.approval?.status === 'allowed' &&
      state.approval.toolName === 'rollback_execute' &&
      !recoveryVerified)
  ) {
    return 'executing';
  }
  if (recoveryVerified) {
    if (state.closeout.pagerduty.status === 'success') return 'resolved';
    if (Object.values(state.closeout).some(item => item.status !== 'idle')) {
      return 'closing';
    }
    return 'recovered';
  }
  if (state.sandbox.status === 'success') return 'verifying';
  if (state.choice !== 'idle' || state.openUi !== 'idle') return 'deciding';
  if (state.fanIn === 'ready' || state.fanIn === 'correlated') {
    return 'correlating';
  }
  if (Object.values(state.workers).some(worker => worker.status !== 'idle')) {
    return 'investigating';
  }
  return 'standby';
}

function same<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function revised(
  previous: IncidentTelemetry,
  next: IncidentTelemetry,
): IncidentTelemetry {
  const phase = phaseFor(next);
  const candidate = { ...next, phase, revision: previous.revision };
  if (same(previous, candidate)) return previous;
  return { ...candidate, revision: previous.revision + 1 };
}

export function reduceTelemetry(
  state: IncidentTelemetry,
  action: TelemetryAction,
): IncidentTelemetry {
  if (action.type === 'reset') return createInitialTelemetry();

  if (action.type === 'session') {
    return revised(state, {
      ...state,
      sessionId: action.sessionId,
      replay: action.replay ?? state.replay,
    });
  }
  if (action.type === 'connection') {
    return revised(state, { ...state, connection: action.status });
  }
  if (action.type === 'worker') {
    const previous = state.workers[action.name];
    const worker: WorkerTelemetry = {
      ...previous,
      status: action.status,
      stepCount: action.stepCount ?? previous.stepCount,
      ...(action.elapsedText === undefined
        ? {}
        : { elapsedText: action.elapsedText }),
    };
    const workers = { ...state.workers, [action.name]: worker };
    const workerStatuses = Object.values(workers).map(item => item.status);
    const fanIn = workerStatuses.some(status => status === 'error')
      ? 'blocked'
      : workerStatuses.every(status => status === 'success')
        ? state.openUi === 'ready'
          ? 'correlated'
          : 'ready'
        : state.fanIn;
    return revised(state, {
      ...state,
      workers,
      fanIn,
    });
  }
  if (action.type === 'tool') {
    const previousTool = state.tools[action.key];
    const tool: ToolTelemetry = {
      key: action.key,
      name: action.name,
      status: action.status,
      ...(action.provider ? { provider: action.provider } : {}),
      ...(action.worker ? { worker: action.worker } : {}),
      ...(action.evidenceSnippet
        ? { evidenceSnippet: action.evidenceSnippet }
        : {}),
    };
    let workers = state.workers;
    if (action.worker) {
      const previousWorker = workers[action.worker];
      const gainedEvidence =
        action.status === 'success' &&
        previousTool?.status !== 'success' &&
        action.evidenceSnippet !== undefined;
      workers = {
        ...workers,
        [action.worker]: {
          ...previousWorker,
          activeTool: action.status === 'running' ? action.name : undefined,
          lastTool:
            action.status === 'running' ? previousWorker.lastTool : action.name,
          lastToolStatus:
            action.status === 'running'
              ? previousWorker.lastToolStatus
              : action.status,
          evidenceCount:
            previousWorker.evidenceCount + (gainedEvidence ? 1 : 0),
          ...(action.evidenceSnippet
            ? { evidenceSnippet: action.evidenceSnippet }
            : {}),
        },
      };
    }
    return revised(state, {
      ...state,
      tools: { ...state.tools, [action.key]: tool },
      workers,
    });
  }
  if (action.type === 'fan-in') {
    return revised(state, { ...state, fanIn: action.status });
  }
  if (action.type === 'openui') {
    return revised(state, {
      ...state,
      openUi: action.status,
      fanIn:
        action.status === 'ready' && state.fanIn === 'ready'
          ? 'correlated'
          : state.fanIn,
    });
  }
  if (action.type === 'choice') {
    return revised(state, { ...state, choice: action.status });
  }
  if (action.type === 'incident') {
    return revised(state, {
      ...state,
      incident: { ...state.incident, ...action.facts },
    });
  }
  if (action.type === 'recovery') {
    return revised(state, {
      ...state,
      recovery: { ...state.recovery, ...action.evidence },
    });
  }
  if (action.type === 'approval') {
    const approval: ApprovalTelemetry = {
      ...(action.id ? { id: action.id } : {}),
      ...(action.toolCallId ? { toolCallId: action.toolCallId } : {}),
      toolName: action.toolName,
      status: action.status,
      ...(action.target ? { target: action.target } : {}),
      ...(action.reason ? { reason: action.reason } : {}),
      ...(action.completedAt ? { completedAt: action.completedAt } : {}),
    };
    const match = (item: ApprovalTelemetry) =>
      (approval.id && item.id === approval.id) ||
      (approval.toolCallId && item.toolCallId === approval.toolCallId);
    const approvals = state.approvals.some(match)
      ? state.approvals.map(item =>
          match(item) ? { ...item, ...approval } : item,
        )
      : [...state.approvals, approval];
    return revised(state, {
      ...state,
      approvals,
      approval,
    });
  }
  if (action.type === 'sandbox') {
    return revised(state, {
      ...state,
      sandbox: {
        status: action.status,
        ...(action.name ? { name: action.name } : {}),
        ...(action.exitCode === undefined ? {} : { exitCode: action.exitCode }),
        ...(action.resultSummary
          ? { resultSummary: action.resultSummary }
          : {}),
      },
    });
  }
  if (action.type === 'closeout') {
    return revised(state, {
      ...state,
      closeout: {
        ...state.closeout,
        [action.provider]: {
          status: action.status,
          ...(action.reference ? { reference: action.reference } : {}),
        },
      },
    });
  }
  if (action.type === 'skill') {
    return revised(state, {
      ...state,
      skill: {
        status: action.status,
        ...(action.name ? { name: action.name } : {}),
        ...(action.reference ? { reference: action.reference } : {}),
      },
    });
  }
  if (action.type === 'saved-agent') {
    return revised(state, {
      ...state,
      savedAgent: {
        status: action.status,
        ...(action.name ? { name: action.name } : {}),
        ...(action.id ? { id: action.id } : {}),
      },
    });
  }
  if (action.type === 'offloaded-evidence') {
    if (state.offloadedEvidence.includes(action.path)) return state;
    return revised(state, {
      ...state,
      offloadedEvidence: [...state.offloadedEvidence, action.path],
    });
  }
  return revised(state, {
    ...state,
    sdkTrigger: {
      status: action.status,
      ...(action.sessionId ? { sessionId: action.sessionId } : {}),
    },
  });
}

export type TelemetryStore = ReturnType<typeof createTelemetryStore>;

export function createTelemetryStore(initial = createInitialTelemetry()) {
  let snapshot = initial;
  const listeners = new Set<() => void>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const dispatch = (action: TelemetryAction) => {
    const next = reduceTelemetry(snapshot, action);
    if (next === snapshot) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe,
    dispatch,
  };
}

export const incidentTelemetry = createTelemetryStore();

export function useIncidentTelemetry(): IncidentTelemetry {
  return useSyncExternalStore(
    incidentTelemetry.subscribe,
    incidentTelemetry.getSnapshot,
    incidentTelemetry.getSnapshot,
  );
}
