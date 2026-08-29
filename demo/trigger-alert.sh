#!/usr/bin/env bash
set -euo pipefail

trueforge_base_url="${TRUEFORGE_BASE_URL:-http://127.0.0.1:8790}"
agent_name="${ONCALL_AGENT_NAME:-oncall-incident-responder}"
incident_id="${1:-INC-4821}"

if [[ ! "$incident_id" =~ ^INC-[0-9]+$ ]]; then
  printf '%s\n' "Incident ID must match INC-<digits>; received ${incident_id}" >&2
  exit 2
fi

headers=(-H 'Accept: application/json' -H 'Content-Type: application/json')
if [[ -n "${TRUEFORGE_TOKEN:-}" ]]; then
  headers+=(-H "Authorization: Bearer ${TRUEFORGE_TOKEN}")
fi

session_payload=$(printf '{"agent":{"name":"%s"}}' "$agent_name")
session_response=$(curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 30 \
  "${headers[@]}" \
  -X POST "${trueforge_base_url}/api/v1/sessions" \
  --data "$session_payload")

session_id=$(node -e '
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof payload?.data?.id !== "string") throw new Error("Session response is missing data.id");
  process.stdout.write(payload.data.id);
});
' <<<"$session_response")

message=$(printf '%s' "A production alert fired for incident ${incident_id}. Start the on-call incident response workflow now. Retrieve current incident data from the connected incident tools before making any claim. Acknowledge the incident, investigate with the four runbook workers in parallel, and present evidence-linked remediation choices. Do not execute a write or destructive action without the required human approval.")
turn_payload=$(node -e '
const message = process.argv[1];
process.stdout.write(JSON.stringify({
  input: [{ type: "user.message", content: message }],
  previous_turn_id: "auto",
  stream: false,
}));
' "$message")

curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 30 \
  "${headers[@]}" \
  -X POST "${trueforge_base_url}/api/v1/sessions/${session_id}/turns" \
  --data "$turn_payload" >/dev/null

printf '%s\n' "${session_id}"
printf '%s\n' "Operator URL: ${ONCALL_OPERATOR_URL:-http://127.0.0.1:4173}/sessions/${session_id}"
