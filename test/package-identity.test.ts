import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_PACKAGE_NAME,
  SDK_PACKAGE_NAME,
  LEGACY_CLI_PACKAGE_NAMES,
  LEGACY_SDK_PACKAGE_NAMES,
  getInstalledCliPackageName,
  isKnownCliPackageSpec,
  registryPackagePath,
} from '../packages/squad-cli/src/cli/core/package-identity.js';
import { selfUpgradeCommand, stripAgentStamps } from '../packages/squad-cli/src/cli/core/upgrade.js';
// @ts-expect-error -- plain ESM script without type declarations
import { applyRules, npmRules } from '../scripts/rename-distribution-identity.mjs';

const identity = JSON.parse(readFileSync(join(process.cwd(), 'scripts/release/distribution-identity.json'), 'utf8'));
const legacyCli = identity.npm.cli.legacy[0] as string;

describe('distribution identity', () => {
  it('runtime package names match scripts/release/distribution-identity.json', () => {
    expect(CLI_PACKAGE_NAME).toBe(identity.npm.cli.current);
    expect(SDK_PACKAGE_NAME).toBe(identity.npm.sdk.current);
    expect([...LEGACY_CLI_PACKAGE_NAMES]).toEqual(identity.npm.cli.legacy);
    expect([...LEGACY_SDK_PACKAGE_NAMES]).toEqual(identity.npm.sdk.legacy);
  });

  it('workspace package.json names match the identity file', () => {
    const read = (p: string) => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
    expect(read('packages/squad-cli/package.json').name).toBe(identity.npm.cli.current);
    expect(read('packages/squad-sdk/package.json').name).toBe(identity.npm.sdk.current);
  });

  it('the repository has no leftover retired package names outside preserved paths', () => {
    expect(() => execFileSync(process.execPath, ['scripts/rename-distribution-identity.mjs'], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('legacy CLI install migration', () => {
  it.each([
    ['npm', `npm uninstall -g ${legacyCli} && npm install -g ${CLI_PACKAGE_NAME}@latest`],
    ['pnpm', `pnpm remove -g ${legacyCli} && pnpm add -g ${CLI_PACKAGE_NAME}@latest`],
    ['yarn', `yarn global remove ${legacyCli} && yarn global add ${CLI_PACKAGE_NAME}@latest`],
  ] as const)('%s self-upgrade removes the legacy package before installing the new one', (pm, expected) => {
    expect(selfUpgradeCommand(pm, 'latest', legacyCli)).toBe(expected);
    expect(selfUpgradeCommand(pm, 'latest')).not.toContain('&&');
  });

  it('recognizes legacy MCP package specs and normalizes legacy agent stamps', () => {
    expect(isKnownCliPackageSpec(`${legacyCli}@1.1.0`)).toBe(true);
    expect(isKnownCliPackageSpec(`${CLI_PACKAGE_NAME}@2.0.0`)).toBe(true);
    expect(isKnownCliPackageSpec(`${CLI_PACKAGE_NAME}-extra@2.0.0`)).toBe(false);
    expect(stripAgentStamps(`npx -y ${legacyCli}@1.1.0 state-mcp`)).toBe(stripAgentStamps(`npx -y ${CLI_PACKAGE_NAME}@2.0.0 state-mcp`));
  });

  it('detects the installed CLI package name from the nearest package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'squad-identity-'));
    try {
      const dist = join(root, 'dist', 'cli', 'core');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: legacyCli }));
      expect(getInstalledCliPackageName(dist)).toBe(legacyCli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('encodes scoped names for registry URLs', () => {
    expect(registryPackagePath(CLI_PACKAGE_NAME)).toBe(CLI_PACKAGE_NAME.replace('/', '%2F'));
  });
});

describe('rename codemod', () => {
  it('rewrites package references but keeps legacy names in migration instructions', () => {
    const rules = npmRules(legacyCli, CLI_PACKAGE_NAME);
    const input = `npx -y ${legacyCli}@1.2 state-mcp\nnpm uninstall -g ${legacyCli}\n`;
    expect(applyRules(input, rules)).toBe(`npx -y ${CLI_PACKAGE_NAME}@1.2 state-mcp\nnpm uninstall -g ${legacyCli}\n`);
  });
});
