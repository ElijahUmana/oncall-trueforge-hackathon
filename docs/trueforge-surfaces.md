# TrueForge Surface Map

ONCALL uses the harness as the runtime, safety boundary, and audit substrate.

| Surface | Concrete use in ONCALL |
|---|---|
| Saved reusable agent | `oncall-incident-responder` is registered once and used by UI, terminal, and SDK clients. |
| Model configuration | OpenAI `gpt-5.6-sol` runs with parallel tool calls enabled. |
| Custom MCP | `checkout-svc-sim` exposes incident, evidence, rollback, audit, and provider tools over Streamable HTTP. |
| Official MCP connectors | GitHub supplies repository evidence; Linear supplies follow-up creation and read-back. |
| Dynamic subagents | Four sibling agents investigate logs, metrics, deploys, and code concurrently. |
| Isolated context | Each specialist receives a self-contained prompt and cannot inspect another report. |
| Typed contracts | Every specialist must return one complete JSON object with evidence and no unknowns. |
| SSE streaming | Turn and tool events are consumed while work is in progress. |
| Event replay | Paginated persisted events reconstruct command state after navigation or restart. |
| Persistent sessions | Turns, required actions, subagent threads, tool calls, and decisions survive reconnects. |
| Ask-user | Remediation selection is represented as a native required response. |
| Tool approval | `rollback_execute` pauses at the exact production mutation boundary. |
| OpenUI | The correlated RCA is rendered as a structured evidence surface. |
| Sandbox-as-tool | Native sandbox execution remains independently visible in the session history. |
| Daytona | The approved rollback is prepared and verified inside an ephemeral remote sandbox. |
| Git-backed skill | The evidence-first runbook is pinned to an immutable commit. |
| Code Mode | Awaited MCP calls can be orchestrated inside the harness for diagnostics. |
| Large-response offload | Oversized tool results are moved outside model context and retrieved intentionally. |
| Context management | Compaction preserves long incident sessions without discarding required state. |
| SDK automation | The local trigger creates sessions and turns programmatically. |
| Embedded UI | The native TrueForge workbench is available on a separate operator route. |

The UI never claims hidden reasoning. It visualizes public slot props and persisted structured events only.
