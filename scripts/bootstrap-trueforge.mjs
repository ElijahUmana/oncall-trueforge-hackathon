import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  TrueForgeClient,
  findAgentByName,
} from '../agent/trueforge-client.mjs';
import {
  AGENT_NAME,
  DEFAULT_MODEL_NAME,
  LINEAR_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  SKILL_NAME,
  buildAgentManifest,
} from '../agent/definition.mjs';

/** @typedef {Record<string, any>} JsonRecord */

const execFileAsync = promisify(execFile);

const baseUrl = new URL(
  process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790',
);
const token = process.env.TRUEFORGE_TOKEN;
const trueForgeClient = new TrueForgeClient({
  baseUrl: baseUrl.href,
  ...(token ? { token } : {}),
  timeoutMs: 30_000,
});
const modelName = process.env.TRUEFORGE_MODEL ?? DEFAULT_MODEL_NAME;
const skillRepositoryUrl = process.env.ONCALL_SKILL_REPOSITORY_URL;
const skillRepositoryRef = process.env.ONCALL_SKILL_REPOSITORY_REF;
const skillRepositoryPath =
  process.env.ONCALL_SKILL_REPOSITORY_PATH ?? 'skills/oncall-runbook';
const mcpUrl = process.env.CHECKOUT_MCP_URL ?? 'http://127.0.0.1:8941/mcp';
const outputPath = path.resolve(
  process.env.ONCALL_BOOTSTRAP_OUTPUT ?? '.oncall/bootstrap.json',
);

/** @param {Record<string, string>} extra */
function headers(extra = {}) {
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {unknown} body
 * @param {number[]} expectedStatuses
 * @returns {Promise<JsonRecord>}
 */
async function requestJson(method, pathname, body, expectedStatuses) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: headers(
      body === undefined ? {} : { 'content-type': 'application/json' },
    ),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(
      `${method} ${pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `${method} ${pathname} returned HTTP ${response.status}: ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

function requireEnvironment() {
  const missing = [];
  if (!skillRepositoryUrl) missing.push('ONCALL_SKILL_REPOSITORY_URL');
  if (!skillRepositoryRef) missing.push('ONCALL_SKILL_REPOSITORY_REF');
  if (skillRepositoryRef && !/^[0-9a-f]{40}$/u.test(skillRepositoryRef)) {
    throw new Error(
      'ONCALL_SKILL_REPOSITORY_REF must be an immutable 40-character Git commit SHA',
    );
  }
  if (missing.length > 0)
    throw new Error(`Missing required environment: ${missing.join(', ')}`);
}

/** @returns {Promise<{ compactionStyle: 'stable' | 'modern', version: string }>} */
async function inspectLiveSchema() {
  const document = await requestJson(
    'GET',
    '/api/v1/openapi.json',
    undefined,
    [200],
  );
  const compaction = document?.components?.schemas?.CompactionConfig;
  const properties = compaction?.properties;
  const compactionStyle =
    properties?.trigger !== undefined
      ? 'modern'
      : properties?.compaction_threshold_tokens !== undefined
        ? 'stable'
        : undefined;
  if (compactionStyle === undefined) {
    throw new Error(
      'Live TrueForge OpenAPI does not advertise a supported CompactionConfig shape',
    );
  }
  return {
    compactionStyle,
    version:
      typeof document?.info?.version === 'string'
        ? document.info.version
        : 'unknown',
  };
}

async function verifyPublishedSkill() {
  if (!skillRepositoryUrl || !skillRepositoryRef) {
    throw new Error('Skill repository URL and ref are required');
  }
  const checkout = await mkdtemp(path.join(tmpdir(), 'oncall-skill-verify-'));
  try {
    await execFileAsync('git', ['init', '--template=', checkout]);
    await execFileAsync('git', [
      '-C',
      checkout,
      'fetch',
      '--depth=1',
      skillRepositoryUrl,
      skillRepositoryRef,
    ]);
    const { stdout } = await execFileAsync('git', [
      '-C',
      checkout,
      'rev-parse',
      'FETCH_HEAD',
    ]);
    if (stdout.trim() !== skillRepositoryRef) {
      throw new Error(
        `Published skill resolved to ${stdout.trim()} instead of ${skillRepositoryRef}`,
      );
    }
    await execFileAsync('git', [
      '-C',
      checkout,
      'checkout',
      '--detach',
      'FETCH_HEAD',
    ]);
    const skillFile = path.join(checkout, skillRepositoryPath, 'SKILL.md');
    const content = await readFile(skillFile, 'utf8');
    if (
      !content.includes('name: oncall-runbook') ||
      !content.includes('# ONCALL Incident Runbook')
    ) {
      throw new Error(`Published skill is invalid at ${skillFile}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Published runbook verification failed for ${skillRepositoryUrl}@${skillRepositoryRef}:${skillRepositoryPath}/SKILL.md: ${detail}`,
      { cause: error },
    );
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

async function verifyModelAvailable() {
  const response = await requestJson('GET', '/api/v1/models', undefined, [200]);
  const models = /** @type {JsonRecord[]} */ (response.data ?? []);
  if (!models.some(model => model.name === modelName)) {
    throw new Error(
      `Required model ${modelName} is not configured in TrueForge; configure the verified OpenAI provider before bootstrap`,
    );
  }
}

async function upsertConnector() {
  return requestJson(
    'PUT',
    '/api/v1/settings/mcp-servers',
    {
      manifest: {
        type: 'remote',
        name: MCP_SERVER_NAME,
        url: new URL(mcpUrl).href,
        description:
          'Deterministic checkout incident evidence, state transitions, approval-gated Daytona rollback execution, and external closeout actions.',
      },
    },
    [200],
  );
}

async function verifyConnectorTools() {
  const response = await requestJson(
    'GET',
    `/api/v1/mcp-servers/${encodeURIComponent(MCP_SERVER_NAME)}/tools`,
    undefined,
    [200],
  );
  const tools = /** @type {JsonRecord[]} */ (response.data ?? []);
  const names = new Set(tools.map(tool => String(tool.name)));
  const required = [
    'pagerduty_get_incident',
    'pagerduty_acknowledge',
    'pagerduty_resolve',
    'logs_query',
    'metrics_query',
    'deploys_list',
    'deploy_get',
    'code_get_file',
    'rollback_execute',
    'audit_list',
    'slack_post_message',
  ];
  const missing = required.filter(name => !names.has(name));
  if (missing.length > 0)
    throw new Error(
      `Connector is missing required tools: ${missing.join(', ')}`,
    );
  return [...names].sort();
}

async function verifyLinearConnector() {
  const settings = await requestJson(
    'GET',
    '/api/v1/settings/mcp-servers',
    undefined,
    [200],
  );
  const configured = /** @type {JsonRecord[]} */ (settings.data ?? []).find(
    server => server.name === LINEAR_MCP_SERVER_NAME,
  );
  if (configured === undefined) {
    throw new Error(
      'Official Linear connector is not configured; add it from the TrueForge MCP catalog and complete OAuth before bootstrap',
    );
  }
  if (configured.auth_status?.status !== 'authenticated') {
    throw new Error(
      `Official Linear connector is ${configured.auth_status?.status ?? 'unknown'}; complete OAuth before bootstrap`,
    );
  }
  const response = await requestJson(
    'GET',
    `/api/v1/mcp-servers/${encodeURIComponent(LINEAR_MCP_SERVER_NAME)}/tools`,
    undefined,
    [200],
  );
  const tools = /** @type {JsonRecord[]} */ (response.data ?? []);
  const names = new Set(tools.map(tool => String(tool.name)));
  const required = ['get_workspace', 'list_teams', 'save_issue', 'get_issue'];
  const missing = required.filter(name => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Official Linear connector is missing required tools: ${missing.join(', ')}`,
    );
  }
  return required;
}

async function upsertSkill() {
  return requestJson(
    'PUT',
    '/api/v1/settings/skills',
    {
      manifest: {
        type: 'git',
        name: SKILL_NAME,
        url: skillRepositoryUrl,
        path: skillRepositoryPath,
        ref: skillRepositoryRef,
        description:
          'Evidence-first procedure for production incident investigation, correlation, remediation, verification, and audit.',
      },
    },
    [200],
  );
}

/** @param {'stable' | 'modern'} compactionStyle */
async function upsertAgent(compactionStyle) {
  if (!modelName) throw new Error('TRUEFORGE_MODEL is required');
  const existing = await findAgentByName(trueForgeClient, AGENT_NAME);
  const manifest = buildAgentManifest({ modelName, compactionStyle });
  if (existing === undefined) {
    return requestJson(
      'POST',
      '/api/v1/agents',
      { name: AGENT_NAME, manifest },
      [201],
    );
  }
  return requestJson(
    'PUT',
    `/api/v1/agents/${encodeURIComponent(existing.id)}`,
    { manifest },
    [200],
  );
}

async function main() {
  requireEnvironment();
  await verifyPublishedSkill();
  const { compactionStyle, version } = await inspectLiveSchema();
  await verifyModelAvailable();
  const connector = await upsertConnector();
  const tools = await verifyConnectorTools();
  const linearTools = await verifyLinearConnector();
  const skill = await upsertSkill();
  const agent = await upsertAgent(compactionStyle);
  const result = {
    trueforge: {
      base_url: baseUrl.href,
      version,
      compaction_style: compactionStyle,
    },
    connector: {
      name: connector.data.name,
      url: connector.data.manifest.url,
      tools,
    },
    linear: {
      name: LINEAR_MCP_SERVER_NAME,
      tools: linearTools,
      auth_status: 'authenticated',
    },
    skill: {
      name: skill.data.name,
      ref: skill.data.manifest.ref,
      path: skill.data.manifest.path,
    },
    agent: { id: agent.data.id, name: agent.data.name },
    configured_at: new Date().toISOString(),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
