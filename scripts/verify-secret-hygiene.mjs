import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = path.resolve(import.meta.dirname, '..');
const ignoredNames = new Set([
  '.git',
  '.pnpm-store',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const ignoredPrefixes = [
  path.join(root, 'evidence', 'artifacts', 'playwright-report'),
  path.join(root, 'evidence', 'artifacts', 'playwright-results'),
];
const allowedFiles = new Set([path.join(root, '.env.example')]);
const binaryExtensions = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.sqlite',
  '.webm',
  '.zip',
]);
/** @type {Array<readonly [string, RegExp]>} */
const secretPatterns = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/gu],
  [
    'GitHub token',
    /(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  ],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/gu],
  ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gu],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  [
    'Assigned credential',
    /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{16,}/giu,
  ],
];

/**
 * @param {string} directory
 * @returns {AsyncGenerator<string>}
 */
async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (ignoredPrefixes.some(prefix => absolutePath.startsWith(prefix)))
      continue;
    if (entry.isDirectory()) yield* walk(absolutePath);
    if (entry.isFile()) yield absolutePath;
  }
}

const findings = [];
let scanned = 0;
for await (const file of walk(root)) {
  const relativePath = path.relative(root, file);
  const localEnvironmentFile =
    path.basename(file).startsWith('.env') && !allowedFiles.has(file);
  if (localEnvironmentFile) {
    try {
      await execFileAsync(
        'git',
        ['check-ignore', '--quiet', '--', relativePath],
        {
          cwd: root,
        },
      );
    } catch {
      throw new Error(
        `${relativePath} contains local environment configuration but is not ignored by Git.`,
      );
    }
    continue;
  }
  if (
    allowedFiles.has(file) ||
    binaryExtensions.has(path.extname(file).toLowerCase())
  )
    continue;
  const contents = await readFile(file, 'utf8');
  scanned += 1;
  for (const [label, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(contents)) findings.push(`${relativePath}: ${label}`);
  }
}

if (findings.length > 0) {
  throw new Error(`Potential credentials detected:\n${findings.join('\n')}`);
}
console.log(
  `Scanned ${scanned} source files; no credential patterns detected.`,
);
