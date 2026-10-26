/**
 * A linked team on a git state backend writes its state into the team repo, and only
 * into it (#2320). The team repo's git top level must be the team repo itself, compared
 * canonically; containing the team dir is not enough.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearResolveSquadCache, resolveSquadState } from '../packages/squad-sdk/src/resolution.js';

// Outside this checkout: anywhere under it, `git rev-parse` would find the Squad repo itself.
let root: string;

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test', ...args], {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, ['init']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
}

function makeTeam(dir: string): void {
  mkdirSync(join(dir, '.squad'), { recursive: true });
  writeFileSync(join(dir, '.squad', 'team.md'), '# Team\n');
}

function makeProject(teamRoot: string, stateBackend = 'orphan'): string {
  const project = join(root, 'project');
  mkdirSync(join(project, '.squad'), { recursive: true });
  writeFileSync(join(project, '.squad', 'config.json'), JSON.stringify({ version: 1, teamRoot, stateBackend }));
  return project;
}

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

const real = (p: string) => realpathSync.native(p);
const same = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The repository the resolved git backend runs in (the same fields state-backend-store.ts reads). */
function stateRepo(ctx: NonNullable<ReturnType<typeof resolveSquadState>>): string {
  const b = ctx.backend as unknown as { cwd?: string; repoRoot?: string; orphan?: { cwd?: string } };
  const dir = b.orphan?.cwd ?? b.cwd ?? b.repoRoot;
  if (!dir) throw new Error(`backend ${ctx.backend.name} exposes no repository`);
  return dir;
}

/** No state ref of any git backend was created in `repo`. */
function expectNoStateRefs(repo: string): void {
  expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/squad-state', 'refs/notes'])).toBe('');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squad-linked-boundary-'));
  clearResolveSquadCache();
});

afterEach(() => {
  clearResolveSquadCache();
  rmSync(root, { recursive: true, force: true });
});

describe('linked team on a git state backend: repository boundary (#2320)', () => {
  describe('uses the team repo when its git root is the team repo', () => {
    it.each([
      ['a relative teamRoot', () => '../team'],
      ['an absolute teamRoot', () => join(root, 'team')],
      ["a teamRoot that names the team's .squad dir", () => '../team/.squad'],
      ['a teamRoot with a .. segment that lands on the team repo', () => '../other/../team'],
    ])('%s', (_label, teamRoot) => {
      const team = join(root, 'team');
      makeTeam(team);
      initRepo(team);
      mkdirSync(join(root, 'other'));
      const project = makeProject(teamRoot());

      const ctx = resolveSquadState(project);
      expect(ctx).not.toBeNull();
      expect(same(real(stateRepo(ctx!)), real(team)), `${stateRepo(ctx!)} vs ${real(team)}`).toBe(true);
    });

    it('a team repo that is a linked git worktree', () => {
      const main = join(root, 'team-main');
      makeTeam(main);
      initRepo(main);
      const worktree = join(root, 'team-wt');
      git(main, ['worktree', 'add', '-b', 'team-wt', worktree]);
      const project = makeProject('../team-wt');

      const ctx = resolveSquadState(project);
      expect(same(real(stateRepo(ctx!)), real(worktree)), `${stateRepo(ctx!)} vs ${real(worktree)}`).toBe(true);
    });

    it('a teamRoot that is a symlink or junction to a team repo of its own', () => {
      const team = join(root, 'team');
      makeTeam(team);
      initRepo(team);
      linkDir(team, join(root, 'team-link'));
      const project = makeProject('../team-link');

      const ctx = resolveSquadState(project);
      expect(same(real(stateRepo(ctx!)), real(team)), `${stateRepo(ctx!)} vs ${real(team)}`).toBe(true);
    });

    it.runIf(process.platform === 'win32').each([
      ['the team repo', ''],
      ["the team's .squad dir (spelled .SQUAD)", '\\.SQUAD'],
    ])('a teamRoot naming %s, with a different drive-letter and path case', (_label, suffix) => {
      const team = join(root, 'team');
      makeTeam(team);
      initRepo(team);
      const absolute = real(team);
      const respelled = absolute[0]!.toLowerCase() + absolute.slice(1).toUpperCase() + suffix;
      expect(respelled.slice(0, absolute.length)).not.toBe(absolute);
      const project = makeProject(respelled);

      const ctx = resolveSquadState(project);
      expect(same(real(stateRepo(ctx!)), absolute), `${stateRepo(ctx!)} vs ${absolute}`).toBe(true);
    });
  });

  describe("keeps repoRoot at the project's repository; only the state backend moves to the team repo", () => {
    it.each(['orphan', 'two-layer'])('%s', (stateBackend) => {
      const team = join(root, 'team');
      makeTeam(team);
      initRepo(team);
      const project = makeProject('../team', stateBackend);
      initRepo(project);

      const ctx = resolveSquadState(project)!;
      expect(same(real(ctx.repoRoot), real(project)), `${ctx.repoRoot} vs ${real(project)}`).toBe(true);
      expect(same(real(stateRepo(ctx)), real(team)), `${stateRepo(ctx)} vs ${real(team)}`).toBe(true);
    });
  });

  describe('fails closed instead of writing into another repository', () => {
    const outer = () => join(root, 'outer');
    const nestedTeam = () => join(outer(), 'teams', 'team');
    const setupNested = () => {
      initRepo(outer());
      makeTeam(nestedTeam());
    };

    it.each([
      ['a relative teamRoot', () => '../outer/teams/team'],
      ['an absolute teamRoot', () => nestedTeam()],
      ['a teamRoot with .. traversal', () => '../outer/teams/x/../team'],
    ])('a non-git team dir inside another repository, via %s', (_label, teamRoot) => {
      setupNested();
      const project = makeProject(teamRoot());

      expect(() => resolveSquadState(project)).toThrow(/is not the root of a git repository: it is inside the repository at/);
      expectNoStateRefs(outer());
    });

    it.each(['orphan', 'two-layer'])('the same refusal on the %s backend', (stateBackend) => {
      setupNested();
      const project = makeProject('../outer/teams/team', stateBackend);

      expect(() => resolveSquadState(project)).toThrow(/is not the root of a git repository/);
      expectNoStateRefs(outer());
    });

    it('a teamRoot symlink or junction to a non-git team dir inside another repository', () => {
      setupNested();
      linkDir(nestedTeam(), join(root, 'team-link'));
      const project = makeProject('../team-link');

      expect(() => resolveSquadState(project)).toThrow(/is not the root of a git repository/);
      expectNoStateRefs(outer());
    });

    it("a team .squad that is a symlink or junction into another repository", () => {
      const other = join(root, 'other-repo');
      makeTeam(other);
      initRepo(other);
      const team = join(root, 'team');
      initRepo(team);
      linkDir(join(other, '.squad'), join(team, '.squad'));
      const project = makeProject('../team');

      expect(() => resolveSquadState(project)).toThrow(/squad dir resolves to .*outside the team repo/);
      expectNoStateRefs(other);
      expectNoStateRefs(team);
    });

    it('a team root that is not in any git repository', () => {
      makeTeam(join(root, 'team'));
      const project = makeProject('../team');

      expect(() => resolveSquadState(project)).toThrow(/team root is not in a git repository/);
    });

    it('a team root that does not exist', () => {
      const project = makeProject('../missing-team');

      expect(() => resolveSquadState(project)).toThrow(/team root does not exist or cannot be resolved/);
    });
  });

  it("still refuses to modify or delete the team's state root", () => {
    const team = join(root, 'team');
    makeTeam(team);
    initRepo(team);
    const project = makeProject('../team');

    const ctx = resolveSquadState(project)!;
    const rootError = /Squad state root.*cannot be modified or deleted/i;
    expect(() => ctx.storage.deleteSync(ctx.paths.teamSquadDir)).toThrow(rootError);
    expect(() => ctx.storage.deleteDirSync(ctx.paths.teamSquadDir)).toThrow(rootError);
    expect(() => ctx.storage.writeSync(ctx.paths.teamSquadDir, 'x')).toThrow(rootError);
    expect(dirname(ctx.paths.teamSquadDir)).toBe(team);
  });
});
