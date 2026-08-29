import { Daytona } from '@daytona/sdk';

export interface RollbackEvidence {
  requests: number;
  errors: number;
  error_rate: number;
  p99_ms: number;
  health: string;
}

export interface RollbackExecutionRequest {
  deployId: string;
  deployCommit: string;
}

export interface RollbackExecutionResult {
  repository_url: string;
  branch: string;
  sandbox_id: string;
  pre_evidence: RollbackEvidence;
  revert_sha: string;
  post_evidence: RollbackEvidence;
  remote_sha: string;
  tests_passed: boolean;
  sandbox_deleted: boolean;
  cleanup_error?: string;
}

export interface RollbackExecutor {
  execute(request: RollbackExecutionRequest): Promise<RollbackExecutionResult>;
}

interface ExecuteResponseLike {
  exitCode: number;
  result: string;
}

interface SandboxLike {
  id: string;
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<ExecuteResponseLike>;
  };
}

interface DaytonaLike {
  create(
    params?: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<SandboxLike>;
  delete(sandbox: SandboxLike, timeout?: number, wait?: boolean): Promise<void>;
}

const repositoryUrl = 'https://github.com/ElijahUmana/oncall-demo-svc.git';
const repositoryDirectory = '/workspace/oncall-demo-svc';
const branch = 'main';
const resultMarker = '__ONCALL_ROLLBACK_RESULT__';

function requireCredential(
  name: 'DAYTONA_API_KEY' | 'GITHUB_DEMO_TOKEN',
): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Rollback unavailable: ${name} is not configured`);
  }
  return value;
}

function rollbackScript(): string {
  return `set -euo pipefail
repo_dir=${repositoryDirectory}
git clone --branch ${branch} --single-branch ${repositoryUrl} "$repo_dir"
cd "$repo_dir"
actual_head="$(git rev-parse HEAD)"
if [ "$actual_head" != "$DEPLOY_COMMIT" ]; then
  printf 'Expected deploy %s but remote %s is at %s\\n' "$DEPLOY_COMMIT" "$GITHUB_REPOSITORY" "$actual_head" >&2
  exit 41
fi
EXPECTED_CHECKOUT_STATUS=503 ./verify-incident.sh >/tmp/pre-evidence.json
git reset --hard HEAD
git clean -fdX incident-evidence
git config user.name "$GIT_AUTHOR_NAME"
git config user.email "$GIT_AUTHOR_EMAIL"
git revert --no-edit "$DEPLOY_COMMIT"
revert_sha="$(git rev-parse HEAD)"
./run-tests.sh
EXPECTED_CHECKOUT_STATUS=201 ./verify-incident.sh >/tmp/post-evidence.json
cat > /tmp/git-askpass.sh <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$GITHUB_DEMO_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS
chmod 700 /tmp/git-askpass.sh
GIT_ASKPASS=/tmp/git-askpass.sh GIT_TERMINAL_PROMPT=0 git push origin "HEAD:${branch}"
remote_sha="$(GIT_ASKPASS=/tmp/git-askpass.sh GIT_TERMINAL_PROMPT=0 git ls-remote origin "refs/heads/${branch}" | cut -f1)"
if [ "$remote_sha" != "$revert_sha" ]; then
  printf 'Remote verification failed: pushed %s but observed %s\\n' "$revert_sha" "$remote_sha" >&2
  exit 42
fi
python3 - "$revert_sha" "$remote_sha" <<'PY'
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

print("${resultMarker}" + json.dumps({
    "pre_evidence": evidence("/tmp/pre-evidence.json"),
    "revert_sha": sys.argv[1],
    "post_evidence": evidence("/tmp/post-evidence.json"),
    "remote_sha": sys.argv[2],
    "tests_passed": True,
}))
PY`;
}

function parseExecutionResult(
  output: string,
  sandboxId: string,
): RollbackExecutionResult {
  const markedLine = output
    .split('\n')
    .find(line => line.startsWith(resultMarker));
  if (markedLine === undefined) {
    throw new Error(
      'Daytona rollback output omitted its verified result record',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(markedLine.slice(resultMarker.length));
  } catch (error) {
    throw new Error('Daytona rollback returned malformed result JSON', {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Daytona rollback result was not an object');
  }
  const record = parsed as Record<string, unknown>;
  const preEvidence = parseEvidence(record.pre_evidence, 'pre_evidence');
  const postEvidence = parseEvidence(record.post_evidence, 'post_evidence');
  const revertSha = requireSha(record.revert_sha, 'revert_sha');
  const remoteSha = requireSha(record.remote_sha, 'remote_sha');
  if (record.tests_passed !== true) {
    throw new Error(
      'Daytona rollback result did not confirm the service tests passed',
    );
  }
  if (remoteSha !== revertSha) {
    throw new Error(
      `Daytona rollback result SHA mismatch: revert ${revertSha}, remote ${remoteSha}`,
    );
  }
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
  return {
    repository_url: repositoryUrl,
    branch,
    sandbox_id: sandboxId,
    pre_evidence: preEvidence,
    revert_sha: revertSha,
    post_evidence: postEvidence,
    remote_sha: remoteSha,
    tests_passed: true,
    sandbox_deleted: false,
  };
}

function parseEvidence(value: unknown, field: string): RollbackEvidence {
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

function requireSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`Daytona rollback result ${field} was not a full Git SHA`);
  }
  return value;
}

export class DaytonaRollbackExecutor implements RollbackExecutor {
  readonly #daytonaFactory: (apiKey: string) => DaytonaLike;

  constructor(
    daytonaFactory: (apiKey: string) => DaytonaLike = apiKey =>
      new Daytona({ apiKey, otelEnabled: false }),
  ) {
    this.#daytonaFactory = daytonaFactory;
  }

  async execute(
    request: RollbackExecutionRequest,
  ): Promise<RollbackExecutionResult> {
    const apiKey = requireCredential('DAYTONA_API_KEY');
    const githubToken = requireCredential('GITHUB_DEMO_TOKEN');
    const daytona = this.#daytonaFactory(apiKey);
    let sandbox: SandboxLike | undefined;
    let result: RollbackExecutionResult | undefined;
    let failure: unknown;
    try {
      sandbox = await daytona.create(
        {
          language: 'python',
          ephemeral: true,
          autoDeleteInterval: 30,
          labels: {
            purpose: 'oncall-approved-rollback',
            deploy: request.deployId,
          },
        },
        { timeout: 120 },
      );
      const response = await sandbox.process.executeCommand(
        rollbackScript(),
        '/workspace',
        {
          DEPLOY_COMMIT: request.deployCommit,
          GITHUB_DEMO_TOKEN: githubToken,
          GITHUB_REPOSITORY: repositoryUrl,
          GIT_AUTHOR_NAME: 'Elijah Umana',
          GIT_AUTHOR_EMAIL: 'elijahsam2020@gmail.com',
        },
        300,
      );
      if (response.exitCode !== 0) {
        throw new Error(
          `Daytona rollback command failed with exit code ${response.exitCode}: ${response.result.slice(-4000)}`,
        );
      }
      result = parseExecutionResult(response.result, sandbox.id);
    } catch (error) {
      failure = error;
    }

    if (sandbox !== undefined) {
      try {
        await daytona.delete(sandbox, 120, true);
        if (result !== undefined) {
          result.sandbox_deleted = true;
        }
      } catch (cleanupError) {
        if (failure !== undefined) {
          failure = new AggregateError(
            [failure, cleanupError],
            `Rollback failed and Daytona sandbox ${sandbox.id} cleanup also failed`,
          );
        } else if (result !== undefined) {
          result.cleanup_error =
            cleanupError instanceof Error
              ? cleanupError.message
              : 'Daytona sandbox cleanup failed with a non-Error value';
        }
      }
    }

    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error('Rollback failed with a non-Error value', {
            cause: failure,
          });
    }
    if (result === undefined) {
      throw new Error('Rollback completed without a result');
    }
    return result;
  }
}

export const rollbackExecutor = new DaytonaRollbackExecutor();
