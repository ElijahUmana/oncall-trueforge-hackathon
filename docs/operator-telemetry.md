# Operator Telemetry

The ONCALL interface is an event-derived command surface layered above the native TrueForge workbench.

## Sources

The telemetry bridge consumes persisted public events:

- `turn.created` and `turn.done`
- `thread.created` and `thread.done`
- `model.message` tool calls
- `tool.response`
- `tool.response_required`
- `tool.approval_required`
- later user response and approval turns

Events are ordered deterministically by sequence number when available, then timestamp and event identity.

## Projection

The reducer tracks:

- four specialist lifecycles;
- current and last tool per worker;
- evidence count and concise observation;
- fan-in readiness;
- remediation choice;
- approval state;
- sandbox and rollback evidence;
- Slack, Linear, and incident closeout;
- connection and replay state.

## Trust rules

- Assistant prose never changes incident state.
- Unparseable tool responses become unavailable, not successful.
- OpenUI readiness does not prove correlation.
- Provider messages cannot imply recovery before rollback invariants pass.
- Duplicate events are idempotent.
- A transient stream interruption cannot erase already observed operational state.

The native workbench remains available on a separate route for raw tool payloads and operator inspection.
