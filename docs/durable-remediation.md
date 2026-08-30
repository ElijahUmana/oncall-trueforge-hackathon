# Durable Remediation

The rollback coordinator is a SQLite-backed state machine designed around the crash window between preparation and remote mutation.

## Operation states

- `reserved`
- `prepared`
- `applied`
- `applied_cleanup_failed`
- `failed_pre_push`
- `conflict`

Each operation has a deterministic ID derived from the approved target. A unique active reservation prevents competing mutations.

## Prepare before apply

The Daytona executor first allocates a sandbox, reproduces the incident, creates a deterministic revert, runs tests, and verifies the post-state. The coordinator then persists:

- sandbox ID;
- expected revert SHA;
- pre-evidence;
- post-evidence;
- operation owner and attempt.

Only after this checkpoint does the apply phase receive Git credentials.

## Restart reconciliation

After interruption, the coordinator reads remote HEAD:

- **deploy SHA** — mutation has not happened; retry is safe;
- **expected revert SHA** — mutation happened; mark applied without another push;
- **any other SHA** — mark conflict and stop.

Prepared sandboxes are reattached or stopped during recovery. Terminal operations return their existing audit event instead of repeating side effects.

## Persisted incident state

Incident status, domain audit events, and rollback operations share the same protected SQLite database with WAL, full synchronous writes, foreign keys, and a busy timeout. State survives MCP and TrueForge process restarts.
