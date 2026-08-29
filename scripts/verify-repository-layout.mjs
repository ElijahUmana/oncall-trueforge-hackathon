import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const nestedRepository = path.join(root, 'demo-svc', '.git');
const gitmodulesPath = path.join(root, '.gitmodules');

try {
  await access(nestedRepository);
} catch {
  console.log(
    'Repository layout valid: demo-svc is not a nested Git repository.',
  );
  process.exit(0);
}

let gitmodules;
try {
  gitmodules = await readFile(gitmodulesPath, 'utf8');
} catch {
  throw new Error(
    'demo-svc is a nested Git repository but root .gitmodules is missing. A root commit would create an unusable gitlink.',
  );
}

if (!gitmodules.includes('path = demo-svc')) {
  throw new Error(
    'demo-svc is a nested Git repository but root .gitmodules does not register path = demo-svc.',
  );
}

const { stdout } = await execFileAsync(
  'git',
  ['config', '-f', '.gitmodules', '--get', 'submodule.demo-svc.url'],
  { cwd: root },
);
if (!stdout.trim()) {
  throw new Error('demo-svc submodule URL is empty.');
}

console.log(
  `Repository layout valid: demo-svc submodule uses ${stdout.trim()}.`,
);
