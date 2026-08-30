import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
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
        const artifactContents = await readFile(artifactPath);
        if (artifactContents.length === 0)
          errors.push(`${surface.id}: empty artifact ${artifact}`);
        if (surface.id === 'saved-agent') {
          try {
            const proof = JSON.parse(artifactContents.toString('utf8'));
            /** @type {unknown[]} */
            const connectors = Array.isArray(proof.mcp_servers)
              ? proof.mcp_servers
              : [];
            const connectorNames = connectors
              .filter(
                /**
                 * @param {unknown} server
                 * @returns {server is { name: string }}
                 */
                server =>
                  server !== null &&
                  typeof server === 'object' &&
                  'name' in server &&
                  typeof server.name === 'string',
              )
              .map(server => server.name)
              .sort();
            if (proof.name !== 'oncall-incident-responder')
              errors.push(`${surface.id}: proof names the wrong saved agent`);
            if (proof.model !== 'openai/gpt-5.6-sol')
              errors.push(`${surface.id}: proof uses a stale model`);
            if (
              JSON.stringify(connectorNames) !==
              JSON.stringify(['checkout-svc-sim', 'linear'])
            )
              errors.push(`${surface.id}: proof uses stale connector bindings`);
            if (
              !Array.isArray(proof.skills) ||
              !proof.skills.includes('oncall-runbook')
            )
              errors.push(`${surface.id}: proof omits oncall-runbook`);
            for (const capability of [
              'sandbox',
              'dynamic_sub_agents',
              'generative_ui',
              'ask_user_questions',
              'large_tool_response',
            ]) {
              if (proof.capabilities?.[capability] !== true)
                errors.push(
                  `${surface.id}: proof does not enable ${capability}`,
                );
            }
          } catch (error) {
            if (error instanceof SyntaxError)
              errors.push(`${surface.id}: proof is not valid JSON`);
            else throw error;
          }
        }
        const metadataPath = `${artifactPath}.json`;
        const metadataRelativePath = `${artifact}.json`;
        try {
          const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
          const actualSha256 = createHash('sha256')
            .update(artifactContents)
            .digest('hex');
          if (metadata.schemaVersion !== 1)
            errors.push(
              `${surface.id}: invalid metadata schema ${metadataRelativePath}`,
            );
          if (metadata.artifact !== artifact)
            errors.push(
              `${surface.id}: metadata artifact mismatch ${metadataRelativePath}`,
            );
          if (metadata.surface !== surface.id)
            errors.push(
              `${surface.id}: metadata surface mismatch ${metadataRelativePath}`,
            );
          if (!surface.checks.includes(metadata.check))
            errors.push(
              `${surface.id}: metadata check is not declared ${metadataRelativePath}`,
            );
          if (metadata.bytes !== artifactContents.length)
            errors.push(
              `${surface.id}: metadata byte count mismatch ${metadataRelativePath}`,
            );
          if (metadata.sha256 !== actualSha256)
            errors.push(
              `${surface.id}: metadata SHA-256 mismatch ${metadataRelativePath}`,
            );
        } catch (error) {
          if (error instanceof SyntaxError)
            errors.push(
              `${surface.id}: invalid metadata JSON ${metadataRelativePath}`,
            );
          else if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            errors.push(
              `${surface.id}: missing metadata ${metadataRelativePath}`,
            );
          else throw error;
        }
        for (const trackedPath of [artifact, metadataRelativePath]) {
          try {
            await execFileAsync(
              'git',
              ['check-ignore', '--quiet', '--', trackedPath],
              {
                cwd: root,
              },
            );
            errors.push(
              `${surface.id}: verified evidence is ignored by Git: ${trackedPath}`,
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
