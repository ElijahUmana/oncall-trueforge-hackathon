import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type IncidentStatus = 'triggered' | 'acknowledged' | 'resolved';

export interface AuditEvent {
  sequence: number;
  timestamp: string;
  action: string;
  actor: string;
  incident_id: string;
  details: Record<string, unknown>;
}

interface IncidentSeed {
  id: string;
  service: string;
  severity: string;
  summary: string;
  started_at: string;
  alerted_at: string;
  status: IncidentStatus;
  symptoms: Record<string, number>;
}

interface DeploySeed {
  id: string;
  service: string;
  deployed_at: string;
  commit: string;
  author: string;
  message: string;
  files_changed: string[];
  health: string;
}

interface MetricPoint {
  timestamp: string;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  error_rate_pct: number;
  db_round_trips_p99: number;
}

interface MetricsSeed {
  service: string;
  points: MetricPoint[];
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDataDirectory = resolve(moduleDirectory, '../data');
const compiledDataDirectory = resolve(moduleDirectory, '../../data');
const defaultDataDirectory = existsSync(sourceDataDirectory)
  ? sourceDataDirectory
  : compiledDataDirectory;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ScenarioStore {
  readonly #incidentSeed: IncidentSeed;
  readonly #deploySeeds: DeploySeed[];
  readonly #metricsSeed: MetricsSeed;
  readonly #logLines: string[];
  readonly #sourceFiles: Map<string, string>;
  #incident: IncidentSeed;
  #audit: AuditEvent[] = [];

  constructor(dataDirectory = defaultDataDirectory) {
    this.#incidentSeed = readJson<IncidentSeed>(
      join(dataDirectory, 'incidents/INC-4821.json'),
    );
    this.#deploySeeds = readdirSync(join(dataDirectory, 'deploys'))
      .filter(name => name.endsWith('.json'))
      .map(name => readJson<DeploySeed>(join(dataDirectory, 'deploys', name)))
      .sort((left, right) => left.deployed_at.localeCompare(right.deployed_at));
    this.#metricsSeed = readJson<MetricsSeed>(
      join(dataDirectory, 'metrics/checkout-svc.json'),
    );
    this.#logLines = readFileSync(
      join(dataDirectory, 'logs/checkout-svc-2026-08-29.log'),
      'utf8',
    )
      .trim()
      .split('\n');
    this.#sourceFiles = new Map([
      [
        'checkout_service/orders.py',
        readFileSync(join(dataDirectory, 'code/orders.py'), 'utf8'),
      ],
    ]);
    this.#incident = clone(this.#incidentSeed);
  }

  reset(): void {
    this.#incident = clone(this.#incidentSeed);
    this.#audit = [];
  }

  getIncident(incidentId: string): IncidentSeed {
    this.#assertIncident(incidentId);
    return clone(this.#incident);
  }

  acknowledge(
    incidentId: string,
    actor: string,
  ): { incident: IncidentSeed; audit_event: AuditEvent } {
    this.#assertIncident(incidentId);
    if (this.#incident.status !== 'triggered') {
      throw new Error(
        `Incident ${incidentId} cannot transition from ${this.#incident.status} to acknowledged`,
      );
    }
    this.#incident.status = 'acknowledged';
    const event = this.#record('pagerduty.acknowledged', actor, incidentId, {
      previous_status: 'triggered',
      status: 'acknowledged',
    });
    return { incident: clone(this.#incident), audit_event: event };
  }

  resolve(
    incidentId: string,
    actor: string,
    resolution: string,
  ): { incident: IncidentSeed; audit_event: AuditEvent } {
    this.#assertIncident(incidentId);
    if (this.#incident.status !== 'acknowledged') {
      throw new Error(
        `Incident ${incidentId} cannot transition from ${this.#incident.status} to resolved`,
      );
    }
    this.#incident.status = 'resolved';
    const event = this.#record('pagerduty.resolved', actor, incidentId, {
      previous_status: 'acknowledged',
      status: 'resolved',
      resolution,
    });
    return { incident: clone(this.#incident), audit_event: event };
  }

  queryLogs(
    service: string,
    start: string,
    end: string,
    level?: string,
    contains?: string,
    limit = 100,
  ): {
    service: string;
    start: string;
    end: string;
    count: number;
    truncated: boolean;
    lines: string[];
  } {
    this.#assertService(service);
    const matching = this.#logLines.filter(line => {
      const timestamp = line.slice(0, 24);
      return (
        timestamp >= start &&
        timestamp <= end &&
        (level === undefined || line.includes(` ${level} `)) &&
        (contains === undefined ||
          line.toLowerCase().includes(contains.toLowerCase()))
      );
    });
    return {
      service,
      start,
      end,
      count: matching.length,
      truncated: matching.length > limit,
      lines: matching.slice(0, limit),
    };
  }

  queryMetrics(
    service: string,
    start: string,
    end: string,
    names: string[],
  ): {
    service: string;
    start: string;
    end: string;
    metrics: string[];
    points: Array<Record<string, number | string>>;
  } {
    this.#assertService(service);
    const points = this.#metricsSeed.points
      .filter(point => point.timestamp >= start && point.timestamp <= end)
      .map(
        point =>
          Object.fromEntries([
            ['timestamp', point.timestamp],
            ...names.map(name => [name, point[name as keyof MetricPoint]]),
          ]) as Record<string, number | string>,
      );
    return { service, start, end, metrics: names, points };
  }

  listDeploys(
    service: string,
    start: string,
    end: string,
    limit = 20,
  ): { service: string; deploys: DeploySeed[] } {
    this.#assertService(service);
    const deploys = this.#deploySeeds
      .filter(
        deploy => deploy.deployed_at >= start && deploy.deployed_at <= end,
      )
      .slice(-limit)
      .reverse();
    return { service, deploys: clone(deploys) };
  }

  getDeploy(deployId: string): DeploySeed {
    const deploy = this.#deploySeeds.find(
      candidate => candidate.id === deployId,
    );
    if (deploy === undefined) {
      throw new Error(`Unknown deploy: ${deployId}`);
    }
    return clone(deploy);
  }

  getSourceFile(
    path: string,
    startLine: number,
    endLine?: number,
  ): {
    path: string;
    start_line: number;
    end_line: number;
    total_lines: number;
    content: string;
  } {
    const source = this.#sourceFiles.get(path);
    if (source === undefined) {
      throw new Error(`Unknown source file: ${path}`);
    }
    const lines = source.split('\n');
    const selectedEnd = Math.min(endLine ?? lines.length, lines.length);
    if (startLine > lines.length) {
      throw new Error(
        `start_line ${startLine} exceeds ${path} length ${lines.length}`,
      );
    }
    return {
      path,
      start_line: startLine,
      end_line: selectedEnd,
      total_lines: lines.length,
      content: lines
        .slice(startLine - 1, selectedEnd)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n'),
    };
  }

  listAudit(
    incidentId: string,
    afterSequence = 0,
  ): { incident_id: string; events: AuditEvent[] } {
    this.#assertIncident(incidentId);
    return {
      incident_id: incidentId,
      events: clone(
        this.#audit.filter(event => event.sequence > afterSequence),
      ),
    };
  }

  recordExternalAction(
    action: string,
    actor: string,
    details: Record<string, unknown>,
  ): AuditEvent {
    return this.#record(action, actor, this.#incident.id, details);
  }

  #assertIncident(incidentId: string): void {
    if (incidentId !== this.#incident.id) {
      throw new Error(`Unknown incident: ${incidentId}`);
    }
  }

  #assertService(service: string): void {
    if (service !== this.#incident.service) {
      throw new Error(`Unknown service: ${service}`);
    }
  }

  #record(
    action: string,
    actor: string,
    incidentId: string,
    details: Record<string, unknown>,
    timestamp = this.#nextAuditTimestamp(),
  ): AuditEvent {
    const event: AuditEvent = {
      sequence: this.#audit.length + 1,
      timestamp,
      action,
      actor,
      incident_id: incidentId,
      details,
    };
    this.#audit.push(event);
    return clone(event);
  }

  #nextAuditTimestamp(): string {
    return new Date(
      Date.parse('2026-08-29T14:35:00.000Z') + (this.#audit.length + 1) * 1000,
    ).toISOString();
  }
}

export const scenarioStore = new ScenarioStore();
