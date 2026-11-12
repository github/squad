/**
 * The Squad launcher (`.squad/squad.mjs`, and the plugin's `scripts/squad.mjs`, built from the
 * same template) passes argv to the CLI byte for byte, on every platform (#2469).
 *
 * On Windows, npm installs `squad` and `npx` as `.cmd` shims. Running a shim means going through
 * cmd.exe, which rewrites `&`, `|`, `%VAR%`, `^` and quotes. The launcher must instead run the
 * shim's JavaScript entry with Node, with no shell. These tests put fake shims on PATH that would
 * print `SHELL-USED` if cmd.exe ever ran them, and check every argument arrives unchanged.
 *
 * CI runs this file on Windows and Linux (`.github/workflows/squad-launcher-platforms.yml`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { squadRepoLauncher } from '@bradygaster/squad-sdk/client';

const win = process.platform === 'win32';
const PKG = ['@bradygaster', 'squad-cli'];

/** Arguments cmd.exe or a shell would rewrite, split or expand. */
const HOSTILE = [
  'state-mcp',
  'two words',
  'quote"inside',
  "single'quote",
  '&echo pwned',
  'pipe|more',
  '%PATH%',
  '^caret',
  '!bang!',
  '<in>out',
  '$HOME',
  '`tick`',
  '',
  'trailing\\',
  'back\\"slash',
  'ünïcødé ✓',
];

/** A script that prints its argv as JSON. */
const ECHO = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";

let root: string;
let bin: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-launcher-argv-'));
  bin = path.join(root, 'fake bin'); // a space in the directory, as in "Program Files"
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
  fs.writeFileSync(path.join(root, '.squad', 'squad.mjs'), squadRepoLauncher('2.0.0', '.squad'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, body: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

/** A shim that must never run: under cmd.exe it prints SHELL-USED. */
function cmdShim(name: string): void {
  write(path.join(bin, `${name}.cmd`), '@echo SHELL-USED %*\r\n');
}

function run(args: string[], env: Record<string, string> = {}) {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'TEMP', 'TMP', 'windir'];
  const base = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]));
  return spawnSync(process.execPath, [path.join(root, '.squad', 'squad.mjs'), ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: {
      ...base,
      // The fake bin first, then Node's own directory; no real squad or npx.
      PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
      SQUAD_HOME: path.join(root, 'squad-home'),
      ...env,
    },
  });
}

function parsed(out: ReturnType<typeof run>): string[] {
  expect(out.stderr).toBe('');
  expect(out.stdout).not.toContain('SHELL-USED');
  expect(out.status).toBe(0);
  return JSON.parse(out.stdout);
}

describe('the launcher passes argv through unchanged', () => {
  it('to a squad CLI installed on PATH', () => {
    if (win) {
      cmdShim('squad');
      const pkg = path.join(bin, 'node_modules', ...PKG);
      write(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG.join('/'), version: '2.0.0' }));
      write(path.join(pkg, 'dist', 'cli-entry.js'), ECHO);
    } else {
      write(path.join(bin, 'squad'), `#!/usr/bin/env node\n${ECHO}`, 0o755);
    }
    expect(parsed(run(HOSTILE))).toEqual(HOSTILE);
  });

  it('to npx when SQUAD_ALLOW_NPX=1', () => {
    if (win) {
      cmdShim('npx');
      write(path.join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'), ECHO);
    } else {
      write(path.join(bin, 'npx'), `#!/usr/bin/env node\n${ECHO}`, 0o755);
    }
    expect(parsed(run(HOSTILE, { SQUAD_ALLOW_NPX: '1' }))).toEqual(['-y', `${PKG.join('/')}@2.0.0`, ...HOSTILE]);
  });

  it('to SQUAD_CLI given as a script', () => {
    const entry = path.join(root, 'cli dir', 'cli-entry.js');
    write(entry, ECHO);
    expect(parsed(run(HOSTILE, { SQUAD_CLI: entry }))).toEqual(HOSTILE);
  });

  it('to the project\'s own install', () => {
    const pkg = path.join(root, 'node_modules', ...PKG);
    write(path.join(pkg, 'package.json'), JSON.stringify({ name: PKG.join('/'), version: '2.0.0' }));
    write(path.join(pkg, 'dist', 'cli-entry.js'), ECHO);
    expect(parsed(run(HOSTILE))).toEqual(HOSTILE);
  });

  it.runIf(win)('fails closed when a .cmd shim has no JavaScript entry beside it', () => {
    cmdShim('squad');
    const out = run(['state-mcp']);
    expect(out.status).toBe(1);
    expect(out.stdout).not.toContain('SHELL-USED');
    expect(out.stderr).toContain('set SQUAD_CLI to cli-entry.js');
  });
});
