/**
 * A confined FSStorageProvider whose root is reached through a symlink (macOS `/tmp` is
 * `/private/tmp`; a linked team root in remote mode). The provider stores its root resolved, but
 * callers pass absolute paths in the spelling they were given. Those used to be rejected as
 * "Path traversal blocked", which broke squad_state for such team roots (#2487 scenarios).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FSStorageProvider } from '../packages/squad-sdk/src/storage/fs-storage-provider.js';

let base: string;
let real: string;
let link: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-symlinked-root-')));
  real = path.join(base, 'real-team');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'team.md'), '# Team\n');
  link = path.join(base, 'team-link');
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside\n');
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('FSStorageProvider with a symlinked root', () => {
  it('reads and writes absolute paths spelled through the link', async () => {
    const p = new FSStorageProvider(link);
    expect(await p.read(path.join(link, 'team.md'))).toBe('# Team\n');
    expect(p.readSync(path.join(link, 'team.md'))).toBe('# Team\n');
    expect(p.existsSync(path.join(link, 'team.md'))).toBe(true);
    await p.write(path.join(link, 'decisions', 'inbox', 'a.md'), 'x\n');
    expect(fs.readFileSync(path.join(real, 'decisions', 'inbox', 'a.md'), 'utf8')).toBe('x\n');
    // The root itself and relative paths keep working.
    expect(await p.isDirectory(link)).toBe(true);
    expect(await p.read('team.md')).toBe('# Team\n');
  });

  it('still blocks paths that leave the root, in either spelling', async () => {
    const p = new FSStorageProvider(link);
    await expect(p.read(path.join(link, '..', 'secret.txt'))).rejects.toThrow(/traversal blocked/);
    expect(() => p.readSync(path.join(link, '..', 'secret.txt'))).toThrow(/traversal blocked/);
    await expect(p.read(path.join(real, '..', 'secret.txt'))).rejects.toThrow(/traversal blocked/);
    // A sibling that only shares the link's name as a prefix is outside.
    fs.mkdirSync(`${link}-evil`);
    fs.writeFileSync(path.join(`${link}-evil`, 'x.md'), 'evil\n');
    await expect(p.read(path.join(`${link}-evil`, 'x.md'))).rejects.toThrow(/traversal blocked/);
  });

  it('still blocks a symlink inside the root that points outside it', async () => {
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(real, 'escape.md'));
    const p = new FSStorageProvider(link);
    await expect(p.read(path.join(link, 'escape.md'))).rejects.toThrow(/Symlink traversal blocked/);
    expect(() => p.readSync(path.join(link, 'escape.md'))).toThrow(/Symlink traversal blocked/);
  });
});
