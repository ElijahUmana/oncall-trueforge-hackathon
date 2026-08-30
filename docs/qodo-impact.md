# Qodo Review Impact

Qodo Code Review identified six issues that changed the architecture rather than merely changing style.

## 1. Non-atomic rollback audit

**Finding:** a remote push could complete before durable state recorded the applied operation.

**Change:** split rollback into prepare and apply phases, checkpoint expected SHA and evidence before mutation, then atomically record the terminal audit.

## 2. Rollback and resolve race

**Finding:** incident resolution could race an active rollback.

**Change:** add a unique active reservation and block resolution while remediation is non-terminal.

## 3. State lost on MCP restart

**Finding:** in-memory incident and audit state could disappear.

**Change:** move incident, audit, and rollback state into protected SQLite with restart coverage.

## 4. Truncated SSE accepted as success

**Finding:** end-of-file before `turn.done` could be treated as a complete turn.

**Change:** require terminal state, reconnect with sequence replay, bound retries, and suppress duplicate sequence IDs.

## 5. Saved-agent pagination

**Finding:** bootstrap searched only the first registry page.

**Change:** page through the complete agent list before create or update.

## 6. Browser token exposure

**Finding:** direct browser authentication risked exposing the TrueForge token.

**Change:** introduce a trusted same-origin proxy and assert that no credential variable enters the client bundle.

These changes are covered by focused durability, transport, client, proxy, and restart tests.
