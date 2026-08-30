import type {
  OpenUiFenceBlockProps,
  SandboxToolCallCardProps,
  SubAgentCardProps,
  ToolApprovalBarProps,
  ToolCallCardProps,
} from '@truefoundry/trueforge-ui';
import {
  SPECIALIST_NAMES,
  type CloseoutProvider,
  type SpecialistName,
  type TelemetryAction,
  type TelemetryStatus,
} from './telemetry-store';

const specialistNames = new Set<string>(SPECIALIST_NAMES);

export function asSpecialistName(name: string): SpecialistName | undefined {
  return specialistNames.has(name) ? (name as SpecialistName) : undefined;
}

export function workerAction(
  props: Pick<
    SubAgentCardProps,
    'agentName' | 'status' | 'stepCount' | 'durationText'
  >,
): TelemetryAction | undefined {
  const name = asSpecialistName(props.agentName);
  if (!name) return undefined;
  return {
    type: 'worker',
    name,
    status: props.status,
    stepCount: props.stepCount,
    ...(props.durationText ? { elapsedText: props.durationText } : {}),
  };
}

function statusForTool(
  props: Pick<ToolCallCardProps, 'status' | 'awaiting'>,
): TelemetryStatus {
  if (props.status) return props.status;
  return props.awaiting ? 'running' : 'idle';
}

export function providerForTool(
  toolName: string,
  mcpServerName?: string,
): string | undefined {
  if (mcpServerName) return mcpServerName;
  const normalized = toolName.toLowerCase();
  if (normalized.includes('slack')) return 'slack';
  if (normalized.includes('linear') || normalized.includes('issue')) {
    return 'linear';
  }
  if (normalized.includes('pagerduty') || normalized.includes('incident')) {
    return 'pagerduty';
  }
  if (normalized.includes('github') || normalized.includes('git')) {
    return 'github';
  }
  return undefined;
}

export function closeoutProviderForTool(
  toolName: string,
  mcpServerName?: string,
): CloseoutProvider | undefined {
  const normalized = `${mcpServerName ?? ''} ${toolName}`.toLowerCase();
  if (normalized.includes('slack')) return 'slack';
  if (normalized.includes('linear') || normalized.includes('save_issue')) {
    return 'linear';
  }
  if (
    normalized.includes('pagerduty') ||
    normalized.includes('resolve_incident')
  ) {
    return 'pagerduty';
  }
  return undefined;
}

export function toolActions(
  key: string,
  props: Pick<
    ToolCallCardProps,
    'toolName' | 'status' | 'awaiting' | 'mcpServerName'
  >,
  worker?: SpecialistName,
): TelemetryAction[] {
  const status = statusForTool(props);
  const provider = providerForTool(props.toolName, props.mcpServerName);
  const actions: TelemetryAction[] = [
    {
      type: 'tool',
      key,
      name: props.toolName,
      status,
      ...(provider ? { provider } : {}),
      ...(worker ? { worker } : {}),
    },
  ];
  const closeoutProvider = closeoutProviderForTool(
    props.toolName,
    props.mcpServerName,
  );
  if (closeoutProvider) {
    actions.push({
      type: 'closeout',
      provider: closeoutProvider,
      status,
    });
  }
  return actions;
}

export function approvalAction(
  props: Pick<ToolApprovalBarProps, 'toolName' | 'status'>,
): TelemetryAction {
  return {
    type: 'approval',
    toolName: props.toolName,
    status:
      props.status?.type === 'approved'
        ? 'allowed'
        : props.status?.type === 'denied'
          ? 'denied'
          : 'pending',
    ...(props.status?.reason ? { reason: props.status.reason } : {}),
  };
}

export function sandboxAction(
  props: Pick<
    SandboxToolCallCardProps,
    'name' | 'status' | 'exitCode' | 'resultText' | 'resultJson'
  >,
): TelemetryAction {
  const resultSummary = props.resultText ?? props.resultJson;
  return {
    type: 'sandbox',
    status: props.status,
    name: props.name,
    ...(props.exitCode === undefined ? {} : { exitCode: props.exitCode }),
    ...(resultSummary ? { resultSummary } : {}),
  };
}

export function openUiActions(
  props: Pick<OpenUiFenceBlockProps, 'isStreaming'>,
): TelemetryAction[] {
  return [
    {
      type: 'openui',
      status: props.isStreaming ? 'streaming' : 'ready',
    },
  ];
}
