import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const appsDirectory = path.join(root, 'apps');
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const sensitiveClientVariable =
  /\bVITE_[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY|TOKEN|SECRET)\b/gu;

/**
 * @param {string} directory
 * @returns {AsyncGenerator<string>}
 */
async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(absolutePath);
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      yield absolutePath;
    }
  }
}

const findings = [];
for await (const file of walk(appsDirectory)) {
  const contents = await readFile(file, 'utf8');
  sensitiveClientVariable.lastIndex = 0;
  for (const match of contents.matchAll(sensitiveClientVariable)) {
    findings.push(`${path.relative(root, file)}: ${match[0]}`);
  }
}

if (findings.length > 0) {
  throw new Error(
    `Client-exposed credential variables are forbidden:\n${findings.join('\n')}`,
  );
}

console.log('No client-exposed credential variable names detected.');
