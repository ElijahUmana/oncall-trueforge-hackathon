import { TrueForge } from '@truefoundry/trueforge-sdk';

export const DEFAULT_AGENT_NAME = 'oncall-incident-responder';
export const DEFAULT_INCIDENT_ID = 'INC-4821';

const INCIDENT_ID_PATTERN = /^INC-[0-9]+$/;

export function assertIncidentId(incidentId: string): void {
  if (!INCIDENT_ID_PATTERN.test(incidentId)) {
    throw new Error(
      `Incident ID must match INC-<digits>; received ${incidentId}`,
    );
  }
}

export function buildAlertMessage(incidentId: string): string {
  assertIncidentId(incidentId);
  return [
    `A production alert fired for incident ${incidentId}.`,
    'Start the on-call incident response workflow now.',
    'Retrieve current incident data from the connected incident tools before making any claim.',
    'Acknowledge the incident, investigate with the four runbook workers in parallel, and present evidence-linked remediation choices.',
    'Do not execute a write or destructive action without the required human approval.',
  ].join(' ');
}

type TriggerOptions = {
  baseUrl: string;
  agentName: string;
  incidentId: string;
};

export async function triggerAlert({
  baseUrl,
  agentName,
  incidentId,
}: TriggerOptions): Promise<string> {
  assertIncidentId(incidentId);
  const client = new TrueForge({
    baseUrl,
    timeoutInSeconds: 60,
    stream: { reconnectionEnabled: true, maxReconnectionAttempts: 10 },
  });
  const session = await client.sessions.create({ agent: { name: agentName } });
  await client.sessions.createTurn(session.data.id, {
    input: [{ type: 'user.message', content: buildAlertMessage(incidentId) }],
    previousTurnId: 'auto',
  });
  return session.data.id;
}
