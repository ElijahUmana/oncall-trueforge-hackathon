import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = /** @type {Record<string, string>} */ (
  Object.fromEntries(
    process.argv.slice(2).map(argument => {
      const separator = argument.indexOf('=');
      if (!argument.startsWith('--') || separator < 3) {
        throw new Error(
          'Arguments must use --surface=ID --check=ID --source=PATH',
        );
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
  )
);
const { check, source: sourceArgument, surface } = args;
if (!check || !sourceArgument || !surface) {
  throw new Error('Missing required --surface, --check, or --source argument.');
}

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.cwd(), sourceArgument);
const sourceContents = await readFile(source);
if (sourceContents.length === 0) throw new Error('Evidence source is empty.');

const runId =
  process.env.EVIDENCE_RUN_ID ??
  new Date().toISOString().replaceAll(/[:.]/gu, '-');
const safeRunId = runId.replaceAll(/[^A-Za-z0-9._-]/gu, '_');
const destinationDirectory = path.join(
  root,
  'evidence',
  'artifacts',
  safeRunId,
);
const destination = path.join(destinationDirectory, path.basename(source));
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);

const metadata = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  surface,
  check,
  source: path.relative(root, source),
  artifact: path.relative(root, destination),
  sha256: createHash('sha256').update(sourceContents).digest('hex'),
  bytes: sourceContents.length,
};
await writeFile(
  `${destination}.json`,
  `${JSON.stringify(metadata, null, 2)}\n`,
  { flag: 'wx' },
);
console.log(JSON.stringify(metadata));
