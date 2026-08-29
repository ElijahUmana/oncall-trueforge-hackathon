import { readFile } from 'node:fs/promises';

const agentSource = await readFile(
  new URL('../agent/definition.mjs', import.meta.url),
  'utf8',
);
const serverSource = await readFile(
  new URL('../mcp-servers/checkout-svc-sim/src/server.ts', import.meta.url),
  'utf8',
);

const mcpExecutesRollback = serverSource.includes('await executor.execute({');
const agentClaimsIntentOnly = agentSource.includes(
  'The MCP call records approved intent only; it never executes git.',
);
const agentExecutesSecondRollback = agentSource.includes(
  'Only after rollback_execute succeeds may you use the TrueForge sandbox exec tool.',
);

if (
  mcpExecutesRollback &&
  (agentClaimsIntentOnly || agentExecutesSecondRollback)
) {
  throw new Error(
    'Remediation contract mismatch: rollback_execute performs the Daytona rollback in MCP source, but the agent describes intent-only MCP followed by a second TrueForge sandbox rollback.',
  );
}

if (!mcpExecutesRollback && !agentClaimsIntentOnly) {
  throw new Error(
    'Remediation contract mismatch: rollback_execute is intent-only, but the agent does not state that execution belongs to a later sandbox action.',
  );
}

console.log(
  `Remediation contract aligned in ${mcpExecutesRollback ? 'direct-execution' : 'intent-only'} mode.`,
);
