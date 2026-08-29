---
name: oncall-runbook
description: Evidence-first procedure for investigating, correlating, remediating, verifying, and auditing production incidents with human approval.
---

# ONCALL Incident Runbook

## Evidence standard

Every factual claim must originate in a tool response. Preserve exact timestamps, identifiers, units, source paths, line numbers, and representative log text. Record which tool and arguments produced each observation. Mark missing facts as unknown; do not interpolate them.

An incident has an established root cause only when four specialist reports are complete and their evidence passes the correlation gates below. A plausible recent change is not sufficient.

## Intake

1. Read the authoritative incident record.
2. Confirm incident ID, service, severity, symptoms, start time, and alert time.
3. Acknowledge the incident. The connector policy permits this bounded paging state transition without approval so paging stops promptly.
4. Choose an inclusive UTC investigation window that contains a healthy baseline, the incident start, and the alert.

## Specialist fan-out and typed results

Create log-analyzer, metrics-analyzer, deploy-investigator, and code-blame as four sibling `create_sub_agent` calls in one model response. Their isolated contexts must receive the full incident identity, UTC window, exact task, constraints, and JSON result contract. Subagents cannot see prior conversation context.

Code-blame must independently call `deploys_list` and `deploy_get` to identify the strongest temporal candidate, then read its changed files with `code_get_file`. It must not rely on deploy-investigator context. Agreement between those independently produced deploy IDs and commits is a correlation gate.

Each report must include:

- `contract_version: "1.0"`
- the exact role
- `status: "complete"` or `"insufficient"`
- incident and service identity
- typed role-specific observations
- evidence entries naming tool, arguments, and observed values
- an `unknowns` array

Reject malformed reports. A complete report cannot contain unknowns.

## Correlation gates

Before stating root cause, verify all of the following:

1. All four reports identify the same incident and service.
2. The suspect deploy time is within 120 seconds of the first metric anomaly.
3. The first relevant log error is within 120 seconds of the first metric anomaly.
4. Code-blame identifies the same deploy ID and commit.
5. At least one code finding is in the deploy's changed files.
6. The observed code can explain a concrete observed symptom.
7. Every RCA sentence is traceable to evidence.

If a gate fails, issue a focused follow-up read or state that root cause remains unestablished. Never widen a tolerance solely to make the evidence align.

## Remediation checkpoints

Remediation selection and execution approval are distinct checkpoints.

1. Render the correlated RCA and evidence.
2. Ask the operator to select rollback, restart, manual patch, or escalation without action.
3. Restate the exact target, intended side effect, verification, and recovery boundary.
4. Call the approval-gated execution tool.
5. Stop immediately if approval is denied.
6. Execute only an implemented path. Do not simulate unavailable restart or patch operations.

For rollback, call `rollback_execute` only after the harness shows its destructive tool approval and the operator allows it. That one tool performs the execution in an ephemeral Daytona sandbox; do not run a second native sandbox revert or push.

Accept rollback success only when the typed result proves every invariant:

1. `incident_id` and `deploy_id` match the approved target.
2. `repository_url` and `branch` identify the approved checkout repository and `main`.
3. `sandbox_id` is present.
4. `pre_evidence` is exactly 25 requests, 3 errors, 0.12 error rate, and degraded health.
5. `tests_passed` is `true`.
6. `post_evidence` is exactly 25 requests, 0 errors, 0 error rate, healthy health, and p99 below 1000 ms.
7. `revert_sha` and `remote_sha` are full 40-character Git SHAs and are equal.
8. `sandbox_deleted` is `true` and `cleanup_error` is absent.
9. An audit event records the executed rollback.

Trust only the authoritative MCP tool response, never assistant narration. If credentials are unavailable, execution fails, cleanup fails, or any invariant differs, keep the incident acknowledged, surface the exact tool error, and do not claim rollback, push, or recovery. For any separate non-remediation native sandbox exec, claim an effect only after its tool response has `success === true` and `response.exitCode === 0`.

## Verification and closeout

A mutation is not a resolution. For rollback, the typed `post_evidence` and verified remote SHA returned by `rollback_execute` are the authoritative recovery proof. Do not use the seeded historical metrics as post-rollback health because they describe the original immutable incident timeline. If any typed execution or verification invariant fails, keep the incident acknowledged and report the failure.

Slack delivery, official TrueForge Linear issue creation, and incident resolution are independent approval-gated writes. Create the Linear follow-up with `save_issue` using team `Elijah`, a title containing the incident ID, Markdown RCA and verification evidence, and priority `2`. After approval and successful creation, call `get_issue` exactly once with the returned ID or identifier and verify identifier, title, team, priority, assignee, URL, and description from authoritative tool responses. Never substitute Jira. Keep the incident unresolved when any required closeout is unavailable, denied, fails, or fails read-back verification.

## Audit and persistence

Use TrueForge stable runtime's persisted session and turn events as the harness audit trail. Replay them to prove subagent lifecycle, tool calls and results, approvals, sandbox creation, and final state. Use `audit_list` for domain transitions. Stable `0.1.4` has no lifecycle-hook file; upstream PR #380 is a separate unreleased capability and may be claimed only if its isolated build is explicitly verified and adopted.

The same session ID is the durable incident workspace. Resume it for follow-up questions. Re-query mutable state, but never repeat completed mutations merely because a client reconnected.
