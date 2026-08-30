# Security Model

ONCALL protects credentials, tool boundaries, and externally visible actions.

## Browser boundary

The browser receives no TrueForge bearer token. Vite's trusted local proxy injects authorization server-side for both API and SSE requests. Event streams disable buffering and caching.

## Secret hygiene

Repository verification scans source and configuration for credential patterns. `.env`, runtime databases, WAL files, SHM files, logs, and PID files remain untracked.

## Input validation

- incident IDs match `INC-<digits>`;
- deploy IDs are numeric;
- repository and branch are literal approved values;
- operation IDs are constrained deterministic identifiers;
- Git SHAs must be full lowercase 40-character values;
- Slack text is escaped before Block Kit rendering;
- MCP transport validates localhost origins.

## External effects

The production mutation is approval-gated in TrueForge. The Slack control bridge uses signed, single-use action URLs tied to the session, checkpoint, nonce, and selected value. A stale or altered action is rejected.

## Failure behavior

The system surfaces provider failures, test failures, cleanup failures, remote conflicts, malformed responses, and interrupted streams. It does not catch and discard errors to keep the visual flow green.
