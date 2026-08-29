# checkout-svc-sim

Deterministic checkout incident evidence and stateful incident actions exposed through Model Context Protocol.

## Run

```bash
pnpm --filter @oncall/checkout-svc-sim start
```

The Streamable HTTP endpoint is `http://127.0.0.1:8941/mcp`; health is `http://127.0.0.1:8941/health`. Override the port with `PORT`.

For stdio:

```bash
pnpm --filter @oncall/checkout-svc-sim start:stdio
```

For a compiled process:

```bash
pnpm --filter @oncall/checkout-svc-sim build
pnpm --filter @oncall/checkout-svc-sim start:built
```

In TrueForge, open **Settings → Connectors → Add MCP Server**, select no authentication for local development, and enter `http://127.0.0.1:8941/mcp`.

## Tools

Read-only evidence:

- `pagerduty_get_incident`
- `logs_query`
- `metrics_query`
- `deploys_list`
- `deploy_get`
- `code_get_file`
- `audit_list`

State-changing tools:

- `pagerduty_acknowledge`: `triggered → acknowledged`
- `pagerduty_resolve`: `acknowledged → resolved`
- `rollback_execute`: after TrueForge approval, creates an isolated Daytona sandbox from the configured TrueForge snapshot, verifies the bad deploy, runs pre-remediation evidence, creates and tests the revert, verifies healthy post-remediation evidence, pushes the revert to `main`, verifies the remote SHA, and force-stops the ephemeral sandbox
- `slack_post_message`: performs a real Slack webhook call
- `jira_create_issue`: performs a real Jira Cloud REST call

All successful tool calls return the same value in text `content` and `structuredContent`. Illegal state transitions and external-provider failures return MCP tool errors and never append success audit records.

## External actions

Slack bot delivery is preferred:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...
```

It uses `chat.postMessage`, returns the channel ID and message timestamp, and attempts `chat.getPermalink`. A permalink lookup failure is returned as `permalink_error` without falsely failing or repeating an already delivered message. When no bot token is configured, the tool can use an incoming webhook:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Rollback requires credentials scoped to creating a Daytona sandbox and pushing only the demo repository:

```bash
DAYTONA_API_KEY=...
DAYTONA_SNAPSHOT=trueforge-build-...
GITHUB_DEMO_TOKEN=...
```

The GitHub token is supplied only to the Daytona `codeRun` environment and passed to `/bin/bash` through `GIT_ASKPASS`; it is never embedded in Python or shell source or returned. `DAYTONA_SNAPSHOT` must name the verified TrueForge-built snapshot because Daytona's generic `executeCommand` images have incompatible toolbox shell paths in this account. Missing credentials/configuration, alternate repository/branch, clone/head mismatch, incident reproduction failure, test failure, push failure, remote-SHA mismatch, or recovery verification failure returns an MCP tool error and does not append a rollback-success audit record. After a verified push, sandbox stop failure is returned as `sandbox_stopped: false` with `cleanup_error` so callers do not retry an already completed mutation.

Jira Cloud requires:

```bash
JIRA_BASE_URL=https://your-site.atlassian.net
JIRA_EMAIL=oncall@example.com
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=OPS
```

Missing credentials, non-HTTPS endpoints, network failures, non-success responses, and malformed Jira success payloads fail visibly. Slack and Jira success is reported only after the provider accepts the request.

## Verify

```bash
pnpm --filter @oncall/checkout-svc-sim lint
pnpm --filter @oncall/checkout-svc-sim typecheck
pnpm --filter @oncall/checkout-svc-sim test
```

The suite calls the server through official MCP clients over Streamable HTTP and stdio, starts the compiled JavaScript build, checks localhost Origin rejection, validates incident transitions and deterministic evidence, and exercises Slack/Jira provider acceptance and rejection semantics.
