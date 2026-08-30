import { Daytona } from '@daytona/sdk';

import {
  type AppliedRollback,
  type DurableRollbackExecutor,
  type PreparedRollback,
} from './durable-remediation.js';
import { type RollbackReservationInput } from './durable-state.js';

export const ROLLBACK_REPOSITORY_URL =
  'https://github.com/ElijahUmana/oncall-demo-svc.git' as const;
export const ROLLBACK_BRANCH = 'main' as const;

interface ExecuteResponseLike {
  exitCode: number;
  result: string;
}

interface SandboxLike {
  id: string;
  process: {
    codeRun(
      code: string,
      params?: { env?: Record<string, string> },
      timeout?: number,
    ): Promise<ExecuteResponseLike>;
  };
  stop(timeout?: number, force?: boolean): Promise<void>;
}

interface DaytonaLike {
  create(
    params?: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<SandboxLike>;
  get(sandboxId: string): Promise<SandboxLike>;
}

interface GitHubCommitResponse {
  sha?: unknown;
}

const repositoryDirectoryRoot = '/workspace/oncall-demo-svc';
const prepareMarker = '__ONCALL_ROLLBACK_PREPARED__';
const applyMarker = '__ONCALL_ROLLBACK_APPLIED__';
const deterministicCommitDate = '2026-08-29T14:40:00Z';

function requireConfiguration(name: 'DAYTONA_SNAPSHOT'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Rollback unavailable: ${name} is not configured`);
  }
  return value;
}

function requireCredential(
  name: 'DAYTONA_API_KEY' | 'GITHUB_DEMO_TOKEN',
): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Rollback unavailable: ${name} is not configured`);
  }
  return value;
}

function validateTarget(input: RollbackReservationInput): void {
  if (
    input.repositoryUrl !== ROLLBACK_REPOSITORY_URL ||
    input.branch !== ROLLBACK_BRANCH
  ) {
    throw new Error(
      'Rollback target does not match the approved repository and branch',
    );
  }
}

function repositoryDirectory(operationId: string): string {
  if (!/^rollback_[0-9a-f]{24}$/.test(operationId)) {
    throw new Error(`Invalid rollback operation ID: ${operationId}`);
  }
  return `${repositoryDirectoryRoot}-${operationId}`;
}

function prepareScript(operationId: string): string {
  const repoDirectory = repositoryDirectory(operationId);
  return `set -euo pipefail
mkdir -p /workspace
repo_dir=${repoDirectory}
test ! -e "$repo_dir"
git clone "$ROLLBACK_REPOSITORY_URL" "$repo_dir"
cd "$repo_dir"
git cat-file -e "$DEPLOY_COMMIT^{commit}"
git checkout --detach "$DEPLOY_COMMIT"
CHECKOUT_DB_ROUND_TRIP_MS=34 EXPECTED_CHECKOUT_STATUS=503 ./verify-incident.sh >/tmp/pre-evidence.json
git reset --hard HEAD
git clean -fdX incident-evidence
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
GIT_AUTHOR_DATE="$ROLLBACK_COMMIT_DATE" GIT_COMMITTER_DATE="$ROLLBACK_COMMIT_DATE" git revert --no-edit "$DEPLOY_COMMIT"
revert_sha="$(git rev-parse HEAD)"
./run-tests.sh
CHECKOUT_DB_ROUND_TRIP_MS=34 EXPECTED_CHECKOUT_STATUS=201 ./verify-incident.sh >/tmp/post-evidence.json
python3 - "$revert_sha" <<'PY'
import json
import sys
from pathlib import Path

def evidence(path):
    payload = json.loads(Path(path).read_text())
    metrics = payload["metrics"]
    health = payload["health"]
    return {
        "requests": metrics["checkout_requests_total"],
        "errors": metrics["checkout_errors_total"],
        "error_rate": metrics["checkout_error_rate"],
        "p99_ms": metrics["checkout_p99_ms"],
        "health": health["status"],
    }

print("${prepareMarker}" + json.dumps({
    "pre_evidence": evidence("/tmp/pre-evidence.json"),
    "revert_sha": sys.argv[1],
    "post_evidence": evidence("/tmp/post-evidence.json"),
}))
PY`;
}

function applyScript(operationId: string): string {
  const repoDirectory = repositoryDirectory(operationId);
  return `set -euo pipefail
cd ${repoDirectory}
actual_head="$(git rev-parse HEAD)"
if [ "$actual_head" != "$EXPECTED_REVERT_SHA" ]; then
  printf 'Prepared sandbox HEAD mismatch: expected %s, observed %s\\n' "$EXPECTED_REVERT_SHA" "$actual_head" >&2
  exit 43
fi
cat > /tmp/git-askpass.sh <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$GITHUB_DEMO_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 /tmp/git-askpass.sh
trap 'rm -f /tmp/git-askpass.sh' EXIT
GIT_ASKPASS=/tmp/git-askpass.sh GIT_TERMINAL_PROMPT=0 git push origin "HEAD:$ROLLBACK_BRANCH"
remote_sha="$(GIT_ASKPASS=/tmp/git-askpass.sh GIT_TERMINAL_PROMPT=0 git ls-remote origin "refs/heads/$ROLLBACK_BRANCH" | cut -f1)"
if [ "$remote_sha" != "$EXPECTED_REVERT_SHA" ]; then
  printf 'Remote verification failed: pushed %s but observed %s\\n' "$EXPECTED_REVERT_SHA" "$remote_sha" >&2
  exit 42
fi
python3 - "$remote_sha" <<'PY'
import json
import sys
print("${applyMarker}" + json.dumps({"remote_sha": sys.argv[1]}))
PY`;
}

function pythonCode(script: string): string {
  return `import os
import subprocess
import sys

script = ${JSON.stringify(script)}
process = subprocess.run(
    ["/bin/bash", "-lc", script],
    cwd="/",
    env=os.environ.copy(),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)
sys.stdout.write(process.stdout)
raise SystemExit(process.returncode)
`;
}

function parsePrepared(output: string, sandboxId: string): PreparedRollback {
  const record = parseMarkedObject(output, prepareMarker, 'prepared');
  const preEvidence = parseEvidence(record.pre_evidence, 'pre_evidence');
  const postEvidence = parseEvidence(record.post_evidence, 'post_evidence');
  const revertSha = requireSha(record.revert_sha, 'revert_sha');
  validateEvidence(preEvidence, postEvidence);
  return {
    sandboxId,
    revertSha,
    preEvidence,
    postEvidence,
  };
}

function parseApplied(output: string): string {
  const record = parseMarkedObject(output, applyMarker, 'applied');
  return requireSha(record.remote_sha, 'remote_sha');
}

function parseMarkedObject(
  output: string,
  marker: string,
  context: string,
): Record<string, unknown> {
  const markedLine = output.split('\n').find(line => line.startsWith(marker));
  if (markedLine === undefined) {
    throw new Error(`Daytona rollback output omitted its ${context} record`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(markedLine.slice(marker.length));
  } catch (error) {
    throw new Error(`Daytona rollback returned malformed ${context} JSON`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Daytona rollback ${context} result was not an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseEvidence(value: unknown, field: string) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Daytona rollback result ${field} was not an object`);
  }
  const evidence = value as Record<string, unknown>;
  if (
    typeof evidence.requests !== 'number' ||
    typeof evidence.errors !== 'number' ||
    typeof evidence.error_rate !== 'number' ||
    typeof evidence.p99_ms !== 'number' ||
    typeof evidence.health !== 'string'
  ) {
    throw new Error(
      `Daytona rollback result ${field} omitted required metrics`,
    );
  }
  return {
    requests: evidence.requests,
    errors: evidence.errors,
    error_rate: evidence.error_rate,
    p99_ms: evidence.p99_ms,
    health: evidence.health,
  };
}

function validateEvidence(
  preEvidence: PreparedRollback['preEvidence'],
  postEvidence: PreparedRollback['postEvidence'],
): void {
  if (
    preEvidence.requests !== 25 ||
    preEvidence.errors !== 3 ||
    preEvidence.error_rate !== 0.12 ||
    preEvidence.health !== 'degraded'
  ) {
    throw new Error(
      'Daytona rollback pre-evidence did not reproduce the incident',
    );
  }
  if (
    postEvidence.requests !== 25 ||
    postEvidence.errors !== 0 ||
    postEvidence.error_rate !== 0 ||
    postEvidence.health !== 'healthy' ||
    postEvidence.p99_ms >= 1000
  ) {
    throw new Error('Daytona rollback post-evidence did not verify recovery');
  }
}

function requireSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Daytona rollback result ${field} was not a full Git SHA`);
  }
  return value;
}

export class DaytonaRollbackExecutor implements DurableRollbackExecutor {
  readonly #daytonaFactory: (apiKey: string) => DaytonaLike;
  readonly #fetch: typeof fetch;

  constructor(
    daytonaFactory: (apiKey: string) => DaytonaLike = apiKey =>
      new Daytona({ apiKey, otelEnabled: false }),
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.#daytonaFactory = daytonaFactory;
    this.#fetch = fetchImplementation;
  }

  async inspectRemoteHead(input: RollbackReservationInput): Promise<string> {
    validateTarget(input);
    const githubToken = requireCredential('GITHUB_DEMO_TOKEN');
    let response: Response;
    try {
      response = await this.#fetch(
        `https://api.github.com/repos/ElijahUmana/oncall-demo-svc/commits/${encodeURIComponent(input.branch)}`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${githubToken}`,
            'x-github-api-version': '2022-11-28',
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch (error) {
      throw new Error('Failed to inspect rollback target remote HEAD', {
        cause: error,
      });
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitHub remote HEAD inspection rejected with HTTP ${response.status}: ${body.slice(0, 1000)}`,
      );
    }
    let parsed: GitHubCommitResponse;
    try {
      parsed = JSON.parse(body) as GitHubCommitResponse;
    } catch (error) {
      throw new Error('GitHub remote HEAD inspection returned malformed JSON', {
        cause: error,
      });
    }
    return requireSha(parsed.sha, 'remote_head');
  }

  async prepare(
    input: RollbackReservationInput,
    operationId: string,
    onSandboxCreated: (sandboxId: string) => void,
  ): Promise<PreparedRollback> {
    validateTarget(input);
    const apiKey = requireCredential('DAYTONA_API_KEY');
    requireCredential('GITHUB_DEMO_TOKEN');
    const snapshot = requireConfiguration('DAYTONA_SNAPSHOT');
    const daytona = this.#daytonaFactory(apiKey);
    let sandbox: SandboxLike | undefined;
    try {
      sandbox = await daytona.create(
        {
          snapshot,
          ephemeral: true,
          labels: {
            purpose: 'oncall-approved-rollback',
            deploy: input.deployId,
            operation: operationId,
          },
        },
        { timeout: 120 },
      );
      onSandboxCreated(sandbox.id);
      const response = await sandbox.process.codeRun(
        pythonCode(prepareScript(operationId)),
        {
          env: {
            DEPLOY_COMMIT: input.deployCommit,
            ROLLBACK_REPOSITORY_URL: input.repositoryUrl,
            ROLLBACK_BRANCH: input.branch,
            ROLLBACK_COMMIT_DATE: deterministicCommitDate,
            GIT_AUTHOR_NAME: 'Elijah Umana',
            GIT_AUTHOR_EMAIL: 'elijahsam2020@gmail.com',
          },
        },
        300,
      );
      if (response.exitCode !== 0) {
        throw new Error(
          `Daytona rollback preparation failed with exit code ${response.exitCode}: ${response.result.slice(-4000)}`,
        );
      }
      return parsePrepared(response.result, sandbox.id);
    } catch (error) {
      if (sandbox !== undefined) {
        try {
          await sandbox.stop(120, true);
        } catch (stopError) {
          throw new AggregateError(
            [error, stopError],
            `Rollback preparation failed and Daytona sandbox ${sandbox.id} stop also failed`,
            { cause: stopError },
          );
        }
      }
      throw error;
    }
  }

  async applyPrepared(
    input: RollbackReservationInput,
    operationId: string,
    prepared: PreparedRollback,
  ): Promise<AppliedRollback> {
    validateTarget(input);
    const apiKey = requireCredential('DAYTONA_API_KEY');
    const githubToken = requireCredential('GITHUB_DEMO_TOKEN');
    const daytona = this.#daytonaFactory(apiKey);
    const sandbox = await daytona.get(prepared.sandboxId);
    const response = await sandbox.process.codeRun(
      pythonCode(applyScript(operationId)),
      {
        env: {
          EXPECTED_REVERT_SHA: prepared.revertSha,
          GITHUB_DEMO_TOKEN: githubToken,
          ROLLBACK_BRANCH: input.branch,
        },
      },
      120,
    );
    if (response.exitCode !== 0) {
      throw new Error(
        `Daytona rollback push failed with exit code ${response.exitCode}: ${response.result.slice(-4000)}`,
      );
    }
    const remoteSha = parseApplied(response.result);
    if (remoteSha !== prepared.revertSha) {
      throw new Error(
        `Daytona rollback result SHA mismatch: revert ${prepared.revertSha}, remote ${remoteSha}`,
      );
    }
    return { remoteSha };
  }

  async discardSandbox(sandboxId: string): Promise<void> {
    const apiKey = requireCredential('DAYTONA_API_KEY');
    const daytona = this.#daytonaFactory(apiKey);
    const sandbox = await daytona.get(sandboxId);
    await sandbox.stop(120, true);
  }

  async discardPrepared(prepared: PreparedRollback): Promise<void> {
    await this.discardSandbox(prepared.sandboxId);
  }
}

export const rollbackExecutor = new DaytonaRollbackExecutor();
