import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DurableStateStore,
  type RollbackReservationInput,
} from './durable-state.js';

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
  readonly #state: DurableStateStore;

  constructor(dataDirectory = defaultDataDirectory, statePath = ':memory:') {
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
    this.#state = new DurableStateStore(statePath);
    this.#state.initializeIncident(this.#incidentSeed);
  }

  close(): void {
    this.#state.close();
  }

  reset(): void {
    this.#state.reset(this.#incidentSeed);
  }

  getIncident(incidentId: string): IncidentSeed {
    return this.#state.getIncident(incidentId);
  }

  acknowledge(
    incidentId: string,
    actor: string,
  ): { incident: IncidentSeed; audit_event: AuditEvent } {
    return this.#state.acknowledge(incidentId, actor);
  }

  resolve(
    incidentId: string,
    actor: string,
    resolution: string,
  ): { incident: IncidentSeed; audit_event: AuditEvent } {
    return this.#state.resolve(incidentId, actor, resolution);
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
    return {
      incident_id: incidentId,
      events: this.#state.listAudit(incidentId, afterSequence),
    };
  }

  recordExternalAction(
    action: string,
    actor: string,
    details: Record<string, unknown>,
  ): AuditEvent {
    return this.#state.recordExternalAction(
      this.#incidentSeed.id,
      action,
      actor,
      details,
    );
  }

  reserveRollback(input: RollbackReservationInput) {
    return this.#state.reserveRollback(input);
  }

  durableState(): DurableStateStore {
    return this.#state;
  }

  #assertService(service: string): void {
    if (service !== this.#incidentSeed.service) {
      throw new Error(`Unknown service: ${service}`);
    }
  }
}

const packageDirectory = existsSync(sourceDataDirectory)
  ? resolve(moduleDirectory, '..')
  : resolve(moduleDirectory, '../..');
const defaultStatePath =
  process.env.CHECKOUT_MCP_STATE_PATH ??
  resolve(packageDirectory, '.oncall/checkout-svc-sim.sqlite');

export const scenarioStore = new ScenarioStore(
  defaultDataDirectory,
  defaultStatePath,
);
