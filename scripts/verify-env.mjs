import { readFile } from 'node:fs/promises';

const requiredPublicVariables = ['CHECKOUT_MCP_URL', 'TRUEFORGE_BASE_URL'];
const sensitiveVariables = [
  'OPENAI_API_KEY',
  'DAYTONA_API_KEY',
  'DAYTONA_SNAPSHOT',
  'GITHUB_TOKEN',
  'GITHUB_DEMO_TOKEN',
  'SLACK_WEBHOOK_URL',
  'TRUEFORGE_TOKEN',
];

const contents = await readFile(
  new URL('../.env.example', import.meta.url),
  'utf8',
);
const entries = new Map();

for (const [index, line] of contents.split(/\r?\n/u).entries()) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) continue;

  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(trimmed);
  if (!match)
    throw new Error(`Invalid .env.example entry on line ${index + 1}`);

  const [, name, value] = match;
  if (entries.has(name))
    throw new Error(`Duplicate .env.example variable: ${name}`);
  entries.set(name, value);
}

for (const name of requiredPublicVariables) {
  if (!entries.get(name))
    throw new Error(`${name} must document its local default`);
}

for (const name of sensitiveVariables) {
  if (!entries.has(name))
    throw new Error(`${name} is missing from .env.example`);
  if (entries.get(name) !== '')
    throw new Error(`${name} must be empty in .env.example`);
}

console.log(`Validated ${entries.size} environment variable contracts.`);
