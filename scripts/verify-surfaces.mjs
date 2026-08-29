import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = path.resolve(import.meta.dirname, '..');
const matrixPath = path.join(root, 'evidence', 'surface-matrix.json');
/**
 * @typedef {object} Surface
 * @property {string} id
 * @property {string} name
 * @property {string} officialSource
 * @property {'unsupported' | 'unverified' | 'verified'} status
 * @property {string[]} checks
 * @property {string[]} artifacts
 * @property {string} [reason]
 */

/** @type {{ schemaVersion: number, surfaces: Surface[] }} */
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const statuses = new Set(['unsupported', 'unverified', 'verified']);
const ids = new Set();
const errors = [];

if (matrix.schemaVersion !== 1 || !Array.isArray(matrix.surfaces)) {
  throw new Error(
    'Surface matrix must use schemaVersion 1 and contain surfaces[].',
  );
}

for (const surface of matrix.surfaces) {
  if (!surface.id || ids.has(surface.id))
    errors.push(`Invalid or duplicate surface id: ${surface.id}`);
  ids.add(surface.id);
  if (!statuses.has(surface.status))
    errors.push(`${surface.id}: invalid status ${surface.status}`);
  if (
    !surface.officialSource?.startsWith(
      'https://github.com/truefoundry/trueforge/',
    )
  ) {
    errors.push(
      `${surface.id}: officialSource must reference the official TrueForge repository`,
    );
  }
  if (surface.status === 'verified') {
    if (!Array.isArray(surface.checks) || surface.checks.length === 0) {
      errors.push(
        `${surface.id}: verified surfaces require automated check IDs`,
      );
    }
    if (!Array.isArray(surface.artifacts) || surface.artifacts.length === 0) {
      errors.push(
        `${surface.id}: verified surfaces require captured artifacts`,
      );
    }
    for (const artifact of surface.artifacts ?? []) {
      const artifactPath = path.resolve(root, artifact);
      if (
        !artifactPath.startsWith(
          path.join(root, 'evidence', 'artifacts') + path.sep,
        )
      ) {
        errors.push(
          `${surface.id}: artifact must be under evidence/artifacts: ${artifact}`,
        );
        continue;
      }
      try {
        await access(artifactPath);
        if ((await stat(artifactPath)).size === 0)
          errors.push(`${surface.id}: empty artifact ${artifact}`);
        try {
          await execFileAsync(
            'git',
            ['check-ignore', '--quiet', '--', artifact],
            {
              cwd: root,
            },
          );
          errors.push(
            `${surface.id}: verified artifact is ignored by Git: ${artifact}`,
          );
        } catch (error) {
          if (
            error === null ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 1
          ) {
            throw error;
          }
        }
      } catch {
        errors.push(`${surface.id}: missing artifact ${artifact}`);
      }
    }
  }
  if (surface.status !== 'verified' && (surface.artifacts?.length ?? 0) > 0) {
    errors.push(
      `${surface.id}: non-verified surface cannot advertise artifacts`,
    );
  }
}

if (errors.length > 0) throw new Error(errors.join('\n'));
const verifiedCount = matrix.surfaces.filter(
  surface => surface.status === 'verified',
).length;
const unverifiedCount = matrix.surfaces.filter(
  surface => surface.status === 'unverified',
).length;
const unsupportedCount = matrix.surfaces.filter(
  surface => surface.status === 'unsupported',
).length;
console.log(
  `Surface matrix valid: ${verifiedCount} verified, ${unverifiedCount} unverified, ${unsupportedCount} unsupported.`,
);
