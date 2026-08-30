#!/usr/bin/env bash
set -euo pipefail

operator_url="${ONCALL_OPERATOR_URL:-http://127.0.0.1:4334}"
incident_id="${1:-INC-4821}"

if [[ ! "$incident_id" =~ ^INC-[0-9]+$ ]]; then
  printf '%s\n' "Incident ID must match INC-<digits>; received ${incident_id}" >&2
  exit 2
fi

payload=$(node -e '
process.stdout.write(JSON.stringify({ incident_id: process.argv[1] }));
' "$incident_id")

response=$(curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 45 \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -X POST "${operator_url}/demo/trigger" \
  --data "$payload")

node -e '
const payload = JSON.parse(process.argv[1]);
if (typeof payload.sessionId !== "string") {
  throw new Error(`Trigger response is missing sessionId: ${process.argv[1]}`);
}
console.log(`Incident detected: ${payload.incidentId}`);
console.log(`Slack investigation notification: ${payload.slackStatus}`);
console.log(`ONCALL: ${process.argv[2]}/sessions/${payload.sessionId}`);
if (payload.slackPermalink) console.log(`Slack: ${payload.slackPermalink}`);
' "$response" "$operator_url"
