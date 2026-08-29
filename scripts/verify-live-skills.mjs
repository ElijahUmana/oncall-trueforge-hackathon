import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
const response = await fetch(new URL('/api/v1/settings/skills', baseUrl), {
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) {
  throw new Error(`Unable to list TrueForge skills: HTTP ${response.status}`);
}
const payload = await response.json();
if (
  payload === null ||
  typeof payload !== 'object' ||
  !Array.isArray(payload.data)
) {
  throw new Error('TrueForge skills response has an invalid shape.');
}

for (const skill of payload.data) {
  const manifest = skill?.manifest;
  if (manifest?.type !== 'git') continue;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(
    manifest.url,
  );
  if (!match) {
    throw new Error(
      `Skill ${manifest.name} uses an unsupported git URL: ${manifest.url}`,
    );
  }
  const [, owner, repository] = match;
  const encodedPath = String(manifest.path)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const endpoint = `repos/${owner}/${repository}/contents/${encodedPath}/SKILL.md?ref=${encodeURIComponent(manifest.ref)}`;
  try {
    await execFileAsync('gh', ['api', endpoint, '--jq', '.sha']);
  } catch (error) {
    throw new Error(
      `Configured skill ${manifest.name} is unavailable at ${manifest.url}/tree/${manifest.ref}/${manifest.path}/SKILL.md.`,
      { cause: error },
    );
  }
}

console.log(
  `Validated ${payload.data.length} configured TrueForge skill source(s).`,
);
