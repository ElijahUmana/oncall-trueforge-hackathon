import { useEffect } from 'react';
import { createIngestionContext, ingestEvent } from './telemetry-ingest';
import {
  incidentTelemetry,
  type TelemetryStore,
} from './telemetry-store';

type EventEnvelope = { event?: Record<string, unknown> } & Record<
  string,
  unknown
>;

function routeSessionId(): string | undefined {
  const match = /^\/sessions\/([^/]+)$/.exec(window.location.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function eventSequence(event: Record<string, unknown>): number | undefined {
  return typeof event.sequence_number === 'number' &&
    Number.isFinite(event.sequence_number)
    ? event.sequence_number
    : undefined;
}

function eventTimestamp(event: Record<string, unknown>): number {
  if (typeof event.created_at !== 'string') return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(event.created_at);
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function eventIdentity(event: Record<string, unknown>): string {
  return typeof event.id === 'string' ? event.id : '';
}

export function orderReplayEvents(
  events: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const ordered = events.map((event, index) => ({
    event,
    index,
    sequence: eventSequence(event),
    timestamp: eventTimestamp(event),
    identity: eventIdentity(event),
  }));
  const useSequence = ordered.every(item => item.sequence !== undefined);
  return ordered
    .sort((left, right) => {
      const primary = useSequence
        ? (left.sequence as number) - (right.sequence as number)
        : left.timestamp - right.timestamp;
      return (
        primary ||
        left.identity.localeCompare(right.identity) ||
        left.index - right.index
      );
    })
    .map(({ event }) => event);
}

export function replayEvents(
  events: readonly Record<string, unknown>[],
  store: TelemetryStore,
): void {
  const context = createIngestionContext();
  orderReplayEvents(events).forEach(event => ingestEvent(event, store, context));
}

async function getAllEvents(
  baseUrl: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      baseUrl,
    );
    url.searchParams.set('limit', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`Session event replay failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      data?: EventEnvelope[];
      pagination?: { next_page_token?: string };
    };
    for (const row of payload.data ?? []) {
      const event = row.event ?? row;
      const sequence = eventSequence(event) ?? eventSequence(row);
      events.push(
        sequence === undefined || eventSequence(event) !== undefined
          ? event
          : { ...event, sequence_number: sequence },
      );
    }
    const nextPageToken = payload.pagination?.next_page_token;
    if (nextPageToken && seenPageTokens.has(nextPageToken)) {
      throw new Error('Session event replay returned a repeated page token');
    }
    if (nextPageToken) seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  } while (pageToken);
  return events;
}

export function TelemetryReplayBridge({ baseUrl }: { baseUrl: string }) {
  useEffect(() => {
    const controller = new AbortController();
    let trackedSession: string | undefined;
    let inFlight = false;

    const sync = async () => {
      const sessionId = routeSessionId();
      if (!sessionId) {
        if (trackedSession !== undefined) {
          trackedSession = undefined;
          incidentTelemetry.dispatch({ type: 'reset' });
        }
        incidentTelemetry.dispatch({ type: 'connection', status: 'live' });
        return;
      }
      if (sessionId !== trackedSession) {
        trackedSession = sessionId;
        incidentTelemetry.dispatch({ type: 'reset' });
        incidentTelemetry.dispatch({ type: 'session', sessionId, replay: true });
        incidentTelemetry.dispatch({ type: 'connection', status: 'connecting' });
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const events = await getAllEvents(baseUrl, sessionId, controller.signal);
        if (controller.signal.aborted || routeSessionId() !== sessionId) return;
        replayEvents(events, incidentTelemetry);
        incidentTelemetry.dispatch({ type: 'connection', status: 'live' });
      } catch (error) {
        if (controller.signal.aborted) return;
        incidentTelemetry.dispatch({
          type: 'connection',
          status: 'interrupted',
        });
        console.error(error);
      } finally {
        inFlight = false;
      }
    };

    void sync();
    const timer = window.setInterval(() => void sync(), 1500);
    window.addEventListener('popstate', () => void sync());
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [baseUrl]);
  return null;
}
