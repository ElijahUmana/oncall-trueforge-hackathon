# Daytona Execution

Daytona provides the isolated environment for the approved recovery.

```mermaid
sequenceDiagram
    participant T as TrueForge
    participant M as Incident MCP
    participant D as Daytona
    participant G as GitHub

    T->>M: rollback_execute (approved target)
    M->>D: create ephemeral sandbox
    D->>G: clone repository
    D->>D: checkout bad deploy
    D->>D: reproduce 25 requests / 3 errors
    D->>D: generate deterministic revert
    D->>D: run test suite
    D->>D: verify 25 requests / 0 errors
    M->>M: persist expected SHA + evidence
    D->>G: push approved revert
    D->>G: read remote branch SHA
    G-->>D: verified recovery SHA
    D->>D: stop sandbox
    M-->>T: typed pre/post recovery result
```

## Credential boundary

Preparation receives no push token. The GitHub credential is supplied only to the apply phase after approval and durable checkpointing.

## Deterministic identity

The revert uses a fixed commit date and explicit author identity so retries generate the same SHA. This lets the coordinator prove whether a prior mutation already landed.

## Typed success result

The MCP returns the sandbox ID, exact pre/post metrics, test status, revert SHA, remote SHA, cleanup status, and audit event. The operator UI derives recovery from these fields rather than from model prose.
