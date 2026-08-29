import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const serviceDirectory = path.join(root, 'demo-svc');
const deployPath = path.join(
  root,
  'mcp-servers/checkout-svc-sim/data/deploys/deploy-9921.json',
);
const deploy = JSON.parse(await readFile(deployPath, 'utf8'));

if (deploy.id !== '9921' || typeof deploy.commit !== 'string') {
  throw new Error('deploy-9921.json must contain id 9921 and a commit SHA.');
}

const { stdout } = await execFileAsync(
  'git',
  ['rev-list', '-n', '1', 'deploy-9921'],
  { cwd: serviceDirectory },
);
const taggedCommit = stdout.trim();

if (deploy.commit !== taggedCommit) {
  throw new Error(
    `Rollback identity mismatch: MCP deploy 9921 uses ${deploy.commit}, but demo-svc tag deploy-9921 resolves to ${taggedCommit}.`,
  );
}

console.log(`Rollback identity aligned at ${taggedCommit}.`);
