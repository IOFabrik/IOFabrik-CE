import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedRepository = 'git+https://github.com/IOFabrik/ladder-visualizer.git';
const immutableDependencyPattern = new RegExp(
  `^${expectedRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#[0-9a-f]{40}$`,
);
const npmLockResolutionPattern =
  /^git\+(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)IOFabrik\/ladder-visualizer\.git#[0-9a-f]{40}$/;

const [packageJson, packageLock, visualizerPackage] = await Promise.all([
  readJson(resolve(frontendRoot, 'package.json')),
  readJson(resolve(frontendRoot, 'package-lock.json')),
  readJson(resolve(frontendRoot, 'node_modules/ladder-visualizer/package.json')),
]);

const dependency = packageJson.dependencies?.['ladder-visualizer'];
assert(
  typeof dependency === 'string' && immutableDependencyPattern.test(dependency),
  'frontend/package.json must pin ladder-visualizer to a full IOFabrik Git commit.',
);

assert(
  packageLock.packages?.['']?.dependencies?.['ladder-visualizer'] === dependency,
  'frontend/package-lock.json must lock the same ladder-visualizer dependency as package.json.',
);

const lockedPackage = packageLock.packages?.['node_modules/ladder-visualizer'];
assert(
  typeof lockedPackage?.resolved === 'string' &&
    npmLockResolutionPattern.test(lockedPackage.resolved) &&
    lockedPackage.resolved.slice(-40) === dependency.slice(-40),
  'frontend/package-lock.json must resolve ladder-visualizer to the same pinned Git commit.',
);
assert(
  typeof lockedPackage?.integrity === 'string' && lockedPackage.integrity.startsWith('sha512-'),
  'frontend/package-lock.json must record package integrity for ladder-visualizer.',
);

assert(
  typeof visualizerPackage.exports?.['.'] === 'object' &&
    visualizerPackage.exports?.['./styles'] === './dist/styles/index.css',
  'The installed ladder-visualizer package must expose its root module and public stylesheet.',
);

console.log(`ladder-visualizer dependency verified at ${dependency.slice(-40)}`);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
