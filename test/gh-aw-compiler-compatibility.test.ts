import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MIN_GH_AW_VERSION,
  OWNERSHIP_DESTINATION,
  PACKAGE_NAME,
  materializeRuntime,
  validateCompilerActionPins,
  verifyInstall,
  verifyStagedInstall,
} from '../workflows/shared/squad-install-verifier.mjs';
import { createFirstInstallFixture } from './helpers/gh-aw-install-fixture.js';

const roots: string[] = [];
const revision = 'a'.repeat(40);

function consumer(): string {
  const root = mkdtempSync(join(tmpdir(), 'squad-compiler-compatibility-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const fixture = createFirstInstallFixture(revision, 'mixed');
  for (const [path, content] of fixture.consumerFiles) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(dirname(join(root, OWNERSHIP_DESTINATION)), { recursive: true });
  writeFileSync(join(root, OWNERSHIP_DESTINATION), JSON.stringify(fixture.provenance));
  materializeRuntime(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('gh-aw 1.x canonical upstream installation contract', () => {
  it('binds the current compiler and native ownership to github/squad, not the fork', () => {
    expect(MIN_GH_AW_VERSION, 'compiler contract must support the validated v1.0.1 release').toBe('v1.0.1');
    expect(PACKAGE_NAME, 'upstream install must own github/squad/workflows').toBe('github/squad/workflows');
    expect(OWNERSHIP_DESTINATION, 'staging must use the real github/squad ownership path')
      .toBe('.github/aw/packages/github-squad-workflows-23a7638f599e.json');
  });

  it('accepts actual v1.0.1 emitted locks and stages the canonical ownership record', () => {
    const root = consumer();
    for (const name of ['squad-bootstrap', 'squad']) {
      const path = `.github/workflows/${name}.lock.yml`;
      const lock = readFileSync(join(root, path), 'utf8');
      expect(lock, `${path} must bind setup to the approved immutable v1.0.1 action`)
        .toContain('github/gh-aw-actions/setup@221ba4f4319de6b8e809d1a15528b3ae6a818aa5');
      expect(() => validateCompilerActionPins(lock), `${path} emitted compiler pins`).not.toThrow();
    }
    expect(verifyInstall(root, { expectedRevision: revision }).failures, root).toEqual([]);
    execFileSync('git', ['add', '--', '.github/aw/', '.github/workflows/', '.github/skills/'], { cwd: root });
    expect(verifyStagedInstall(root, { expectedRevision: revision }).failures, root).toEqual([]);
  }, 120_000);

  it.each([
    ['legacy installer', 'installer', 'gh-aw v0.91.5'],
    ['unvalidated future compiler', 'installer', 'gh-aw v1.0.2'],
    ['old fork identity', 'package', 'bradygaster/squad/workflows'],
  ])('rejects the offending %s without trusting different compiler output', (label, key, value) => {
    const root = consumer();
    const path = join(root, OWNERSHIP_DESTINATION);
    const ownership = JSON.parse(readFileSync(path, 'utf8'));
    ownership[key] = value;
    writeFileSync(path, JSON.stringify(ownership));
    expect(verifyInstall(root, { expectedRevision: revision }).failures.join('\n'), `${label}: ${value}`)
      .toContain(key === 'package'
        ? `Package ownership source must be ${value}@${revision}.`
        : 'Package ownership installer must be gh-aw v1.0.1.');
  }, 120_000);

  it('rejects a realistic mutation of the emitted immutable compiler pin and complete lock bytes', () => {
    const root = consumer();
    const path = '.github/workflows/squad-bootstrap.lock.yml';
    const lock = readFileSync(join(root, path), 'utf8');
    const mutation = lock.replaceAll(
      '221ba4f4319de6b8e809d1a15528b3ae6a818aa5',
      '16b430146d5d5646eccef5a1ceb72152333b18b9',
    );
    expect(mutation, `${path} must contain the actual 1.0.1 pin before mutation`).not.toBe(lock);
    expect(() => validateCompilerActionPins(mutation), `${path}: legacy setup SHA`)
      .toThrow(/invalid immutable action pin/);
    writeFileSync(join(root, path), mutation);
    expect(verifyInstall(root).failures.join('\n'), `${path}: mutated compiler bytes`).toContain(path);
  }, 120_000);
});
