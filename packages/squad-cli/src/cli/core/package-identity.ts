/**
 * Published npm identity of the Squad CLI and SDK — zero dependencies (node: built-ins only).
 *
 * The values mirror scripts/release/distribution-identity.json. `LEGACY_*` names are retired
 * identities that existing global installs, MCP configs and generated agent files may still
 * reference; Squad keeps recognizing them so upgrading never strands an install.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_PACKAGE_NAME = '@squad/cli';
export const SDK_PACKAGE_NAME = '@squad/sdk';
export const LEGACY_CLI_PACKAGE_NAMES: readonly string[] = ['@bradygaster/squad-cli'];
export const LEGACY_SDK_PACKAGE_NAMES: readonly string[] = ['@bradygaster/squad-sdk'];

/** Every name the CLI has been published under, current first. */
export const KNOWN_CLI_PACKAGE_NAMES: readonly string[] = [CLI_PACKAGE_NAME, ...LEGACY_CLI_PACKAGE_NAMES];

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex alternation matching any known CLI package name (`@scope/name`). */
export const KNOWN_CLI_NAME_PATTERN = KNOWN_CLI_PACKAGE_NAMES.map(escapeRe).join('|');

/** Same alternation, with the scope separator matching both `/` and `\` (installed paths). */
export const KNOWN_CLI_PATH_PATTERN = KNOWN_CLI_PACKAGE_NAMES
  .map(name => name.split('/').map(escapeRe).join('[\\\\/]'))
  .join('|');

/** Registry metadata path for a scoped name, e.g. `@squad%2Fcli`. */
export function registryPackagePath(name: string): string {
  return name.replaceAll('/', '%2F');
}

/** True when `spec` is `<known CLI name>` or `<known CLI name>@<version|tag>`. */
export function isKnownCliPackageSpec(spec: string): boolean {
  return new RegExp(`^(?:${KNOWN_CLI_NAME_PATTERN})(?:@.+)?$`).test(spec);
}

/** True when `name` is a retired CLI identity. */
export function isLegacyCliPackageName(name: string): boolean {
  return LEGACY_CLI_PACKAGE_NAMES.includes(name);
}

/**
 * Name of the CLI package this code was installed as, read from the nearest package.json.
 * A 2.x build published under a legacy name reports that name, which lets self-upgrade
 * move the install to the current identity.
 */
export function getInstalledCliPackageName(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && KNOWN_CLI_PACKAGE_NAMES.includes(pkg.name)) return pkg.name;
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return CLI_PACKAGE_NAME;
}
