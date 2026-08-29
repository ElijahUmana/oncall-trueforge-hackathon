import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
/** @type {{ surfaces: Array<{ artifacts?: string[] }> }} */
const matrix = JSON.parse(
  await readFile(path.join(root, 'evidence', 'surface-matrix.json'), 'utf8'),
);
const required = new Set([
  '.env.example',
  '.github/workflows/ci.yml',
  '.gitmodules',
  'agent/definition.mjs',
  'apps/operator/package.json',
  'demo-svc',
  'evidence/surface-matrix.json',
  'mcp-servers/checkout-svc-sim/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'skills/oncall-runbook/SKILL.md',
  ...matrix.surfaces.flatMap(surface =>
    (surface.artifacts ?? []).flatMap(artifact => [
      artifact,
      `${artifact}.json`,
    ]),
  ),
]);

const { stdout } = await execFileAsync('git', ['ls-files', '--stage'], {
  cwd: root,
});
const entries = new Map(
  stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [metadata, file] = line.split('\t');
      return [file, metadata?.split(' ')[0]];
    }),
);
const missing = [...required].filter(file => !entries.has(file));
if (missing.length > 0) {
  throw new Error(
    `Required publication files are not tracked by Git:\n${missing.join('\n')}`,
  );
}
if (entries.get('demo-svc') !== '160000') {
  throw new Error('demo-svc must be tracked as a Git submodule (mode 160000).');
}

console.log(
  `Publication index valid: ${required.size} required files are tracked.`,
);
