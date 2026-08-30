# Safety Boundaries

ONCALL separates investigation, selection, approval, preparation, mutation, and closeout.

```mermaid
stateDiagram-v2
    [*] --> Investigating
    Investigating --> Correlated: four valid reports
    Correlated --> Selected: operator chooses rollback
    Selected --> ApprovalPending: exact tool request
    ApprovalPending --> Stopped: deny
    ApprovalPending --> Preparing: allow
    Preparing --> Prepared: tests + pre/post evidence
    Prepared --> Applying: durable checkpoint
    Applying --> Recovered: remote SHA verified
    Applying --> Conflict: unrelated remote SHA
    Recovered --> Closed: provider updates complete
```

## Invariants

- Remediation choice is not execution permission.
- Only `rollback_execute` crosses the production mutation boundary.
- The approval payload fixes the incident, deploy, repository, branch, actor, and reason.
- Preparation does not receive push credentials.
- Expected revert SHA and evidence are durable before push.
- A competing rollback cannot reserve the same incident.
- Incident resolution is blocked while remediation is active.
- A denied approval ends remediation immediately.
- Failed tests, mismatched SHAs, missing evidence, or sandbox cleanup failure remain visible.

## Recovery boundary

Recovery requires all of the following:

- degraded pre-state reproduced;
- tests passed;
- healthy post-state verified;
- revert SHA equals remote SHA;
- sandbox stopped;
- durable audit event written.

Assistant narration cannot satisfy any of these invariants.
