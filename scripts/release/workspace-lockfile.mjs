#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const packages = lock.packages ?? {};
const identity = JSON.parse(readFileSync(new URL('./distribution-identity.json', import.meta.url), 'utf8'));
const workspaceNames = [identity.npm.cli, identity.npm.sdk].flatMap((entry) => [entry.current, ...entry.legacy]);
const stale = Object.keys(packages).filter((key) =>
  workspaceNames.some((name) => key.endsWith(`/node_modules/${name}`))
  && packages[key].resolved?.startsWith('https://'));

if (mode === 'fix') {
  if (stale.length) {
    for (const key of stale) {
      console.log(`Removing: ${key}`);
      delete packages[key];
    }
    writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  } else {
    console.log('Lockfile clean');
  }
} else if (mode === 'check') {
  if (stale.length) {
    console.error('::error::WORKSPACE INTEGRITY FAILURE — stale registry packages in lockfile.');
    for (const key of stale) console.error(`  STALE: ${key} → ${packages[key].resolved}`);
    console.error('Fix: ensure workspace versions match, then npm install at repo root.');
    process.exit(1);
  }
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const sdk = JSON.parse(readFileSync('packages/squad-sdk/package.json', 'utf8'));
  const cli = JSON.parse(readFileSync('packages/squad-cli/package.json', 'utf8'));
  if (new Set([root.version, sdk.version, cli.version]).size !== 1) {
    throw new Error('Root, SDK, and CLI versions must match.');
  }
  const dependency = cli.dependencies?.['@squad/sdk'];
  const lockDependency = packages['packages/squad-cli']?.dependencies?.['@squad/sdk'];
  if (sdk.version.includes('-')) {
    const expected = `>=${sdk.version}`;
    if (dependency !== expected || lockDependency !== expected) {
      throw new Error(`Preview versions require the CLI SDK dependency and lockfile entry to be ${expected}`);
    }
  } else if (dependency?.includes('-') || lockDependency?.includes('-')) {
    throw new Error('Stable versions cannot retain a prerelease SDK dependency floor.');
  }
  console.log('✅ All workspace packages resolve to local file: links');
} else {
  throw new Error('usage: workspace-lockfile.mjs <fix|check>');
}
