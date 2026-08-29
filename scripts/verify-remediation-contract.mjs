import { readFile } from 'node:fs/promises';

const agentSource = await readFile(
  new URL('../agent/definition.mjs', import.meta.url),
  'utf8',
);
const serverSource = await readFile(
  new URL('../mcp-servers/checkout-svc-sim/src/server.ts', import.meta.url),
  'utf8',
);
const executorSource = await readFile(
  new URL(
    '../mcp-servers/checkout-svc-sim/src/rollback-executor.ts',
    import.meta.url,
  ),
  'utf8',
);

const mcpExecutesRollback = serverSource.includes('await executor.execute({');
const agentClaimsIntentOnly = agentSource.includes(
  'The MCP call records approved intent only; it never executes git.',
);
const agentExecutesSecondRollback = agentSource.includes(
  'Only after rollback_execute succeeds may you use the TrueForge sandbox exec tool.',
);
const expectedRepositoryUrl =
  'https://github.com/ElijahUmana/oncall-demo-svc.git';
const approvalBindsRepository =
  serverSource.includes('repository_url: z.literal(ROLLBACK_REPOSITORY_URL)') &&
  executorSource.includes(
    `export const ROLLBACK_REPOSITORY_URL =\n  '${expectedRepositoryUrl}' as const`,
  ) &&
  serverSource.includes('repositoryUrl: repository_url');
const approvalBindsBranch =
  serverSource.includes('branch: z.literal(ROLLBACK_BRANCH)') &&
  executorSource.includes("export const ROLLBACK_BRANCH = 'main' as const") &&
  serverSource.includes('branch,');
const agentSuppliesRepository =
  agentSource.includes('repository_url') &&
  agentSource.includes(expectedRepositoryUrl);
const agentSuppliesBranch =
  agentSource.includes('branch') && agentSource.includes('main');

if (
  mcpExecutesRollback &&
  (!approvalBindsRepository ||
    !approvalBindsBranch ||
    !agentSuppliesRepository ||
    !agentSuppliesBranch)
) {
  throw new Error(
    'Atomic rollback approval mismatch: rollback_execute must require literal repository_url and branch inputs, and the agent must supply the exact approved target before Daytona execution.',
  );
}

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
