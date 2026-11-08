/**
 * gh-aw-enlistment skill — structural validity, discoverability, and safety-gate
 * regression guard.
 *
 * The skill operationalizes the supported Squad gh-aw bootstrap
 * (docs/src/content/docs/guide/gh-aw.md). Its value is entirely in the safety
 * gates it encodes, so this suite asserts:
 *   1. The canonical SKILL.md parses into a valid SkillDefinition.
 *   2. Its frontmatter advertises the documented trigger phrases (discoverability).
 *   3. Its body still encodes every critical safety gate (allowlist, strict
 *      compile, never-auto-merge, read-only token, explicit staging).
 *   4. The canonical source and all four mirrors are byte-for-byte identical
 *      (the sync invariant every canonical skill upholds).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from '@bradygaster/squad-sdk/skills';
import {
  LEGACY_OWNERSHIP_DESTINATIONS,
  LEGACY_PACKAGE_NAMES,
  OWNERSHIP_DESTINATION,
  PACKAGE_NAME,
  UNOWNED_MUTABLE_ROUTER_SKILL,
} from '../workflows/shared/squad-install-verifier.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SKILL_ID = 'gh-aw-enlistment';

const CANONICAL = `.squad-templates/skills/${SKILL_ID}/SKILL.md`;
const GUIDE = 'docs/src/content/docs/guide/gh-aw.md';
const AGENT_GUIDE = '.github/agents.md';
const MIRRORS = [
  `workflows/skills/${SKILL_ID}/SKILL.md`,
  `templates/skills/${SKILL_ID}/SKILL.md`,
  `packages/squad-cli/templates/skills/${SKILL_ID}/SKILL.md`,
  `packages/squad-sdk/templates/skills/${SKILL_ID}/SKILL.md`,
] as const;

// Public install commands are bound to the verifier's canonical package identity.
const INSTALL_COMMAND = `gh aw add "${PACKAGE_NAME}@\${SQUAD_SHA}"`;
const [LEGACY_PACKAGE_NAME] = LEGACY_PACKAGE_NAMES;
const [LEGACY_OWNERSHIP] = LEGACY_OWNERSHIP_DESTINATIONS;
const SQUAD_INIT_ACTION = `${PACKAGE_NAME.replace(/\/workflows$/, '')}/.github/actions/squad-init`;
const DELETION_FILTER = [
  `    grep -vxF -e '${UNOWNED_MUTABLE_ROUTER_SKILL}' \\`,
  `      -e '${LEGACY_OWNERSHIP}' || true`,
].join('\n');

function extractDeletionGate(content: string): string {
  const start = content.indexOf('unexpected_deletions="$(');
  const end = content.indexOf('\n}', content.indexOf('test -z "${unexpected_deletions}"', start));
  expect(start, 'staged-deletion gate must exist').toBeGreaterThan(-1);
  expect(end, 'staged-deletion gate must end with its STOP block').toBeGreaterThan(start);
  return content.slice(start, end + 2);
}

function runDeletionGate(gate: string, deletions: readonly string[]) {
  const script = `
set -euo pipefail
git() { printf '%s' "$STAGED_DELETIONS"; }
${gate}
`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, STAGED_DELETIONS: deletions.map(path => `${path}\n`).join('') },
  });
}

const IDENTITY_GATE_START = '# squad-package-identity-start';
const IDENTITY_GATE_END = '# squad-package-identity-end';
const IDENTITY_SHA = 'c'.repeat(40);
const LEGACY_INSTALL_PREFIX = `gh aw add "${LEGACY_PACKAGE_NAME}@`;
const MANIFEST_RULE = `\`${PACKAGE_NAME}\` verifies only at Squad revisions whose `
  + `\`workflows/squad-workflows.manifest.json\` declares \`"package": "${PACKAGE_NAME}"\``;
const IDENTITY_LEGACY_HINT = `Install a revision that declares ${LEGACY_PACKAGE_NAME} under that identity, `
  + 'or ask the Squad maintainers for a newer revision.';
const IDENTITY_UNREADABLE_STOP = 'STOP: cannot read workflows/squad-workflows.manifest.json from github/squad '
  + `at ${IDENTITY_SHA}.`;
const IDENTITY_UNREADABLE_HINT = 'Check gh auth status --hostname github.com and network access, '
  + 'and confirm SQUAD_SHA is a github/squad commit that has this manifest, then retry.';

function extractIdentityGate(content: string): string {
  const start = content.indexOf(IDENTITY_GATE_START);
  const end = content.indexOf(IDENTITY_GATE_END);
  expect(start, `${IDENTITY_GATE_START} must exist`).toBeGreaterThan(-1);
  expect(content.indexOf(IDENTITY_GATE_START, start + 1), 'one marked identity gate per document').toBe(-1);
  expect(end, `${IDENTITY_GATE_END} must follow its start marker`).toBeGreaterThan(start);
  return content.slice(start + IDENTITY_GATE_START.length + 1, end);
}

function runIdentityGate(gate: string, response: { manifestPackage?: string; fail?: boolean }) {
  const script = `
set -euo pipefail
exec 3>&2
gh() {
  printf 'CALL %s\\n' "$*" >&3
  if [ "$GH_FAIL" = "1" ]; then
    printf '{"message":"No commit found for the ref"}\\n'
    return 1
  fi
  printf '%s\\n' "$GH_PACKAGE"
}
SQUAD_SHA="${IDENTITY_SHA}"
${gate}
echo "IDENTITY GATE PASSED"
`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, GH_PACKAGE: response.manifestPackage ?? '', GH_FAIL: response.fail ? '1' : '0' },
  });
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map(match => match[1]);
}

function readRaw(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}
/** LF-normalized read — markdown is not pinned to LF, so Windows checkouts get CRLF. */
function readLF(rel: string): string {
  return readRaw(rel).replace(/\r\n/g, '\n');
}

const VERSION_GATE_START = '# gh-aw-exact-version-start';
const VERSION_GATE_END = '# gh-aw-exact-version-end';

function extractVersionGate(content: string): string {
  const start = content.indexOf(VERSION_GATE_START);
  const end = content.indexOf(VERSION_GATE_END);
  expect(start, `${VERSION_GATE_START} must exist`).toBeGreaterThan(-1);
  expect(end, `${VERSION_GATE_END} must follow its start marker`).toBeGreaterThan(start);
  return content.slice(start + VERSION_GATE_START.length, end);
}

function runVersionGate(
  gate: string,
  initialVersion: string,
  installedVersion: string,
  versionStream: 'stdout' | 'stderr' = 'stdout',
) {
  const script = `
set -euo pipefail
installed=0
exec 3>&2
gh() {
  if [ "$1" = "aw" ] && [ "$2" = "--version" ]; then
    printf 'CALL version\\n' >&3
    version="$INITIAL_VERSION"
    if [ "$installed" -eq 1 ]; then version="$INSTALLED_VERSION"; fi
    if [ "$VERSION_STREAM" = "stderr" ]; then
      printf 'gh-aw %s\\n' "$version" >&2
    else
      printf 'gh-aw %s\\n' "$version"
    fi
    return 0
  fi
  if [ "$1" = "extension" ] && [ "$2" = "remove" ] && [ "$3" = "gh-aw" ]; then
    printf 'CALL remove\\n' >&3
    return 0
  fi
  if [ "$1" = "extension" ] && [ "$2" = "install" ]; then
    printf 'CALL install %s %s\\n' "$3" "$4" >&3
    installed=1
    return 0
  fi
  return 64
}
${gate}
`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INITIAL_VERSION: initialVersion,
      INSTALLED_VERSION: installedVersion,
      VERSION_STREAM: versionStream,
    },
  });
}

const COMPILE_WARNINGS = [
  '.github/workflows/squad-review.md: warning: pull_request_target is a very dangerous trigger.',
  ".github/workflows/squad.md: warning: Both slash_command and bots triggers are configured. If a bot listed in bots: posts a comment that starts with the slash command text (e.g., /command-name), it will trigger the workflow and occupy the concurrency slot, potentially blocking simultaneous manual invocations. To ensure the workflow only runs on explicit user commands, remove the 'bots:' field.",
];

function assertCompileWarningContract(content: string): void {
  const regions = [...content.matchAll(
    /^<!-- compile-warning-allowlist-start -->\n```text\n([\s\S]*?)\n```\n<!-- compile-warning-allowlist-end -->$/gm,
  )];
  expect(regions).toHaveLength(1);
  expect(regions[0][1].split('\n')).toEqual(COMPILE_WARNINGS);
  const flat = content.replace(/\s+/g, ' ');
  expect(flat).toContain('require exactly two warnings, one occurrence of each exact diagnostic header');
  expect(flat).toContain('**STOP** on any error, or on **any additional warning** beyond these two exact documented diagnostics.');
  expect(flat).toContain('Also STOP if either warning is missing, duplicated, changed, or attributed to another path');
  expect(flat).toContain('Compiled 8 workflows: 8 succeeded, 2 warnings');
  expect(flat).toContain('or if any required control is absent.');
  expect(flat).toContain('Do not suppress warnings or use `--approve` to bypass this gate.');
}

describe.each([CANONICAL, ...MIRRORS, GUIDE])('%s strict compile warning contract', path => {
  const content = readLF(path);

  it('allows exactly the native review advisory and bot-trigger diagnostic with hard-stop semantics', () => {
    assertCompileWarningContract(content);
  });

  it('conditions the native review exception on every existing control', () => {
    const flat = content.replace(/\s+/g, ' ');
    expect(flat).toContain('**only while all existing controls remain**');
    for (const control of [
      'same-repository head restriction', 'base-controlled workflow source',
      '`checkout: false` agent path', 'API-only inspection', 'exact run/head/attempt guard',
      'least-privilege jobs', 'advisory verdict', 'independent human approval',
    ]) expect(flat).toContain(control);
    expect(flat).toContain('`pull_request_target` is not generally safe');
  });

  it.each([
    ['unknown third warning', `${COMPILE_WARNINGS.join('\n')}\n.github/workflows/squad.md: warning: unknown diagnostic`],
    ['missing review warning', COMPILE_WARNINGS[1]],
    ['missing bot warning', COMPILE_WARNINGS[0]],
    ['duplicate warning', `${COMPILE_WARNINGS.join('\n')}\n${COMPILE_WARNINGS[0]}`],
    ['different workflow path', COMPILE_WARNINGS.join('\n').replace('squad-review.md', 'untrusted.md')],
    ['changed diagnostic', COMPILE_WARNINGS.join('\n').replace('very dangerous', 'safe')],
  ])('rejects a contract mutation allowing %s', (_label, replacement) => {
    const mutated = content.replace(COMPILE_WARNINGS.join('\n'), replacement);
    expect(mutated).not.toBe(content);
    expect(() => assertCompileWarningContract(mutated)).toThrow();
  });

  it('rejects removal of the error/additional-warning hard stop', () => {
    const mutated = content.replace('**STOP** on any error', 'Continue on any error');
    expect(mutated).not.toBe(content);
    expect(() => assertCompileWarningContract(mutated)).toThrow();
  });
});

describe('gh-aw-enlistment skill', () => {
  it('canonical SKILL.md exists', () => {
    expect(existsSync(resolve(ROOT, CANONICAL)), `${CANONICAL} should exist`).toBe(true);
  });

  it('parses into a valid SkillDefinition', () => {
    const skill = parseSkillFile(SKILL_ID, readLF(CANONICAL));
    expect(skill, 'skill should parse').toBeDefined();
    expect(skill!.id).toBe(SKILL_ID);
    expect(skill!.name).toContain(SKILL_ID);
    expect(skill!.content.length).toBeGreaterThan(0);
  });

  describe('discoverability — frontmatter trigger phrases', () => {
    const content = readLF(CANONICAL);
    // Assert against the PARSED triggers array, not raw text. `toContain` on the
    // whole document would still pass if a phrase were deleted from the
    // frontmatter and merely mentioned in prose — which is the exact regression
    // this block exists to catch, since a phrase in prose is not discoverable.
    // `skill.triggers` is the same array the runtime matcher iterates
    // (packages/squad-sdk/src/skills/index.ts), so this tests the real path.
    const skill = parseSkillFile(SKILL_ID, content);

    it('declares a non-empty triggers block in frontmatter', () => {
      expect(skill, 'skill should parse').toBeDefined();
      expect(Array.isArray(skill!.triggers), 'triggers should parse to an array').toBe(true);
      expect(skill!.triggers.length, 'triggers must not be empty').toBeGreaterThan(0);
    });

    // The three trigger phrases the skill must be discoverable by.
    for (const phrase of [
      'set up Squad agentic workflows',
      'enlist this repo in Squad',
      'install Squad gh-aw workflows',
    ]) {
      it(`is discoverable by "${phrase}"`, () => {
        expect(
          skill!.triggers,
          `"${phrase}" must be a frontmatter trigger, not merely present somewhere in the document`,
        ).toContain(phrase);
      });
    }
  });

  describe('safety gates encoded in the body', () => {
    const content = readLF(CANONICAL);

    // EXCLUSIVITY GUARD — these two tests enforce the exact set of
    // backtick-delimited tokens in the bounded allowlist region.
    // Using deep-equality on a sorted array (not .toContain) so that adding a
    // 4th entry, removing an entry, or renaming one all cause an immediate
    // failure.  The delimiters scope the extraction so identical strings that
    // appear elsewhere in the document (Anti-Patterns section, examples) do
    // NOT count.
    it('allowlist region delimiters exist exactly once each', () => {
      const startMatches = [...content.matchAll(/^<!-- allowlist-start -->$/gm)];
      const endMatches   = [...content.matchAll(/^<!-- allowlist-end -->$/gm)];
      expect(startMatches.length, '<!-- allowlist-start --> must appear exactly once').toBe(1);
      expect(endMatches.length,   '<!-- allowlist-end --> must appear exactly once').toBe(1);
    });

    it('allowlist region contains EXACTLY the two documented secrets and the one documented action — no more, no fewer', () => {
      const startTag = '<!-- allowlist-start -->';
      const endTag   = '<!-- allowlist-end -->';
      const startIdx = content.indexOf(startTag);
      const endIdx   = content.indexOf(endTag);
      expect(startIdx, 'allowlist-start delimiter must exist').toBeGreaterThan(-1);
      expect(endIdx,   'allowlist-end delimiter must exist').toBeGreaterThan(startIdx);

      // Extract strictly between the delimiter lines (exclusive).
      const region = content.slice(startIdx + startTag.length, endIdx);

      // Every backtick-delimited token in the region — order-independent exact set.
      const tokens = [...region.matchAll(/`([^`]+)`/g)].map(m => m[1]);
      expect(tokens.slice().sort(), 'allowlist tokens must be exactly the three documented entries').toEqual(
        [
          'SQUAD_GITHUB_APP_PRIVATE_KEY',
          'SQUAD_GITHUB_TOKEN',
          SQUAD_INIT_ACTION,
        ].sort()
      );

      // Structural: exactly 2 bullet lines (one for the two secrets, one for the action).
      const bulletLines = region.split('\n').filter(l => l.trimStart().startsWith('- '));
      expect(bulletLines.length, 'allowlist region must contain exactly 2 bullet lines').toBe(2);
    });

    it('installs one immutable native package with the 8/17/1 topology', () => {
      expect(content).toContain(': "${SQUAD_SHA:?STOP: set SQUAD_SHA to an explicit, maintainer-approved 40-character Squad commit SHA before installing.}"');
      expect(content).not.toContain('commits/dev');
      expect(content).toContain('^' + '[0-9a-f]{40}' + '$');
      expect(content, `skill must install ${PACKAGE_NAME}`).toContain(INSTALL_COMMAND);
      for (const block of fencedBlocks(content)) {
        expect(block, `no executable block may install the legacy ${LEGACY_PACKAGE_NAME} identity`)
          .not.toContain(LEGACY_INSTALL_PREFIX);
      }
      expect(content).toContain('exactly eight workflows, seventeen runtime resources, and one');
      for (const workflow of [
        'squad.md',
        'squad-implement-worker.md',
        'squad-review.md',
        'squad-deps-worker.md',
        'squad-retro.md',
        'squad-improvement-worker.md',
        'squad-bootstrap.md',
        'squad-command-router.md',
      ]) expect(content).toContain(workflow);
    });

    it('requires the package verifier to validate every shared runtime guard', () => {
      expect(content).toContain('squad-install-verifier.mjs --materialize-runtime');
      expect(content).toContain('--verify-install');
      expect(content).toContain('--source-revision "${SQUAD_SHA}"');
      expect(content).toContain('--strict-compile');
      expect(content).toContain('missing source/lock pair');
      expect(content).toContain('stale source/resource digest');
    });

    it('removes only gh-aw\'s mutable router and preserves the exact Squad skill', () => {
      expect(content.match(/rm -f \.github\/skills\/agentic-workflows\/SKILL\.md/g),
        'install, upgrade and correct-example blocks each remove the router').toHaveLength(3);
      expect(content).toContain('not part of the Squad package');
      expect(content).toContain('Do not adopt or vendor the rest');
      expect(content).toContain('.github/skills/gh-aw-enlistment/SKILL.md');
      expect(content).toContain(DELETION_FILTER);
    });

    it.each([
      ['no deletions', [], 0],
      ['the mutable router', [UNOWNED_MUTABLE_ROUTER_SKILL], 0],
      ['the superseded legacy ownership record', [LEGACY_OWNERSHIP], 0],
      ['the router and the legacy record together', [UNOWNED_MUTABLE_ROUTER_SKILL, LEGACY_OWNERSHIP], 0],
      ['the canonical ownership record', [OWNERSHIP_DESTINATION], 1],
      ['an installed workflow', ['.github/workflows/squad.md'], 1],
      ['a legacy-record prefix match', [`${LEGACY_OWNERSHIP}.bak`], 1],
    ] as const)('the staged-deletion gate handles %s', (label, deletions, status) => {
      const result = runDeletionGate(extractDeletionGate(content), deletions);
      expect(result.status, `${label} (${deletions.join(', ')}): ${result.stderr}`).toBe(status);
      if (status === 1) {
        expect(result.stderr).toContain(`STOP: unexpected staged deletions:\n${deletions.join('\n')}`);
      }
    });

    it('documents the legacy-identity migration that the verifier enforces', () => {
      const flat = content.replace(/\s+/g, ' ');
      const why = `skill must document migrating off ${LEGACY_PACKAGE_NAME} and deleting ${LEGACY_OWNERSHIP}`;
      expect(flat, why).toContain(
        'Earlier revisions, including ones committed after the repository moved to `github/squad`, '
        + `declare and verify only \`${LEGACY_PACKAGE_NAME}\``,
      );
      expect(flat, why).toContain(
        `\`${LEGACY_OWNERSHIP}\` after the forced reinstall, so the block deletes exactly that file before verifying`,
      );
      expect(flat, why).toContain('the verifier fails closed while both ownership records exist');
      expect(flat, 'skill must name the one-time squad-init safe-update change').toContain(
        `action \`${SQUAD_INIT_ACTION}\` added and \`bradygaster/squad/.github/actions/squad-init\` removed.`,
      );
      expect(flat, why).toContain('**STOP** on any other new secret or action.');
      expect(flat, 'skill must say how to stay on a legacy-only revision').toContain(
        `with \`${LEGACY_INSTALL_PREFIX}\${SQUAD_SHA}" --force\`, and skip the second \`rm -f\`: `
        + 'that ownership record is the only one such an installation has.',
      );
      const upgrade = fencedBlocks(content).find(block => block.includes(`${INSTALL_COMMAND} --force`));
      expect(upgrade, 'skill must include an executable upgrade block').toBeDefined();
      const steps = [
        extractIdentityGate(content),
        `${INSTALL_COMMAND} --force`,
        `rm -f ${UNOWNED_MUTABLE_ROUTER_SKILL}`,
        `rm -f ${LEGACY_OWNERSHIP}`,
        'squad-install-verifier.mjs --materialize-runtime',
        'gh aw compile --strict',
        '--verify-install',
      ];
      const order = steps.map(step => upgrade!.indexOf(step));
      expect(order.every(index => index > -1), `upgrade block step positions: ${order.join(', ')}`).toBe(true);
      expect(order, 'upgrade block steps must run in order').toEqual([...order].sort((a, b) => a - b));
      const stepNumber = (title: string) => {
        const heading = content.split('\n').find(line => line.startsWith('### ') && line.endsWith(title));
        expect(heading, `skill must keep the step "${title}"`).toBeDefined();
        return /^### (\d+)\. /.exec(heading!)![1];
      };
      const compileStep = stepNumber('Always run the final strict compile WITHOUT `--approve`');
      const stageStep = stepNumber('Inspect generated files, then stage only the documented surfaces');
      const compileSection = content.slice(
        content.indexOf(`### ${compileStep}. `),
        content.indexOf(`### ${Number(compileStep) + 1}. `),
      );
      expect(compileSection.replace(/\s+/g, ' '), `step ${compileStep} must hold the two-warning check`)
        .toContain('require exactly two warnings');
      expect(flat, 'the upgrade block must hand off to the warning check and staging steps by their current numbers')
        .toContain(`Apply step ${compileStep}'s two-warning check to the compile output above, `
          + `then stage and verify as in step ${stageStep}.`);
    });

    it('gates installation on the revision declaring the canonical package identity', () => {
      const gate = extractIdentityGate(content);
      expect(content.indexOf(IDENTITY_GATE_END), 'the identity gate must precede the install command')
        .toBeLessThan(content.indexOf(INSTALL_COMMAND));
      expect(content.split(gate).length - 1, 'install, upgrade and correct-example blocks must run the same gate')
        .toBe(3);
      const flat = content.replace(/\s+/g, ' ');
      expect(flat, 'skill must state the manifest cutoff').toContain(MANIFEST_RULE);
      expect(flat, 'skill must route older revisions').toContain(
        `An older maintainer-approved revision declares \`${LEGACY_PACKAGE_NAME}\`: install it under that identity, `
        + 'because its verifier accepts no other, or ask the Squad maintainers for a newer revision.',
      );
    });

    it.each([
      ['a revision declaring the canonical package', { manifestPackage: PACKAGE_NAME }, 'pass', ''],
      ['a revision declaring the legacy package', { manifestPackage: LEGACY_PACKAGE_NAME }, 'mismatch',
        LEGACY_PACKAGE_NAME],
      ['a case-variant package', { manifestPackage: 'GitHub/Squad/workflows' }, 'mismatch', 'GitHub/Squad/workflows'],
      ['an unreadable manifest', { fail: true }, 'unreadable', ''],
    ] as const)('the identity gate handles %s', (label, response, outcome, found) => {
      const result = runIdentityGate(extractIdentityGate(content), response);
      expect(result.status, `${label}: ${result.stderr}`).toBe(outcome === 'pass' ? 0 : 1);
      expect(result.stderr, `${label}: the gate must read the manifest at SQUAD_SHA on github.com`).toContain(
        'CALL api --hostname github.com -H Accept: application/vnd.github.raw+json '
        + `repos/github/squad/contents/workflows/squad-workflows.manifest.json?ref=${IDENTITY_SHA} --jq .package`,
      );
      if (outcome === 'pass') {
        expect(result.stdout, label).toContain('IDENTITY GATE PASSED');
        return;
      }
      expect(result.stdout, `${label} must stop before installing`).not.toContain('IDENTITY GATE PASSED');
      if (outcome === 'unreadable') {
        expect(result.stderr, `${label}: the stop must say the manifest could not be read`)
          .toContain(IDENTITY_UNREADABLE_STOP);
        expect(result.stderr, `${label}: the stop must point at gh auth, network access and SQUAD_SHA`)
          .toContain(IDENTITY_UNREADABLE_HINT);
        expect(result.stderr, `${label}: an unreadable manifest must not suggest the legacy identity`)
          .not.toContain(LEGACY_PACKAGE_NAME);
        return;
      }
      expect(result.stderr, label).toContain(
        `STOP: Squad ${IDENTITY_SHA} does not declare the ${PACKAGE_NAME} package (found '${found}').`,
      );
      expect(result.stderr, `${label}: a readable manifest routes to the legacy identity`)
        .toContain(IDENTITY_LEGACY_HINT);
      expect(result.stderr, `${label}: a readable manifest is not an access problem`)
        .not.toContain(IDENTITY_UNREADABLE_HINT);
    });

    it('names the legacy squad-init action only for revisions that declare the legacy identity', () => {
      const flat = content.replace(/\s+/g, ' ');
      expect(flat).toContain(
        `At a revision whose manifest declares \`${LEGACY_PACKAGE_NAME}\`, the same action is reported as `
        + '`bradygaster/squad/.github/actions/squad-init`. Accept that name only for such a revision.',
      );
    });

    it('dates the identity cutoff by the manifest, not by the repository move', () => {
      for (const [path, text] of [
        [CANONICAL, content],
        [GUIDE, readLF(GUIDE)],
        ['workflows/README.md', readLF('workflows/README.md')],
        ['workflows/shared/squad-install-verifier.mjs', readLF('workflows/shared/squad-install-verifier.mjs')],
      ] as const) {
        expect(text.replace(/\s+/g, ' '), `${path} must not date the identity cutoff by the move`)
          .not.toMatch(/before (?:the (?:repository )?move|Squad moved|the repository moved)|pre-move/i);
      }
    });

    it('requires a final strict compile without --approve', () => {
      // The standalone command must appear as its own line (start-of-line in a
      // fenced bash block), not merely as a prose/backtick mention.  The
      // previous lookahead-only regex was flagged by a reviewer as a false
      // positive: the Anti-Patterns prose "finish with a plain `gh aw compile
      // --strict` (no `--approve`)" also matched it.
      //
      // Anchoring with ^, the `m` (multiline) flag, and allowing only an
      // optional trailing # comment means only real command lines satisfy the
      // pattern.  Lines with --approve (L140, L259, L295) do not match because
      // --approve follows --strict before any #.
      expect(content).toMatch(/^gh aw compile --strict(\s+#[^\n]*)?$/m);
    });

    it('keeps the default workflow token read-only', () => {
      expect(content).toContain('default_workflow_permissions=read');
    });

    it('uses native review authority without reviewer credentials or external services', () => {
      expect(content).toContain('native GitHub Actions/gh-aw runtime identity');
      expect(content).toContain('successful `review` job');
      expect(content).toContain('context-only requirement');
      expect(content).not.toMatch(/SQUAD_REVIEW_APP_|squad-review-authority/);
    });

    it('requires GitHub Issues before installation and stops when they cannot be enabled', () => {
      expect(content).toContain('gh api "repos/${owner_repo}" --jq \'.has_issues\'');
      expect(content).toContain(
        'gh api --method PATCH "repos/${owner_repo}"',
      );
      expect(content).toContain('-F has_issues=true --silent');
      expect(content).toContain('requires repository administration permission');
      expect(content).toContain('STOP before branch creation or `gh aw add`');
      expect(content.indexOf("issues_enabled=")).toBeLessThan(content.indexOf('git switch -c'));
      expect(content.indexOf("issues_enabled=")).toBeLessThan(
        content.indexOf(INSTALL_COMMAND),
      );
    });

    it('keeps the standalone correct example fail-closed', () => {
      const correctExample = content.slice(content.indexOf('### ✓ Correct:'));
      expect(correctExample).toContain('if ! gh api --method PATCH "repos/${owner_repo}"');
      expect(correctExample).toContain(
        'test "$(gh api "repos/${owner_repo}" --jq \'.has_issues\')" = "true" || {',
      );
      expect(correctExample).toContain('exit 1');
    });

    it('forbids blanket staging and mandates explicit paths', () => {
      expect(content).toMatch(/git add \.|git add -A|git commit -a/); // referenced as an anti-pattern
      expect(content).toContain('git add -- .gitattributes .github/aw/ .github/workflows/ .github/skills/');
      expect(content.match(/--verify-staged-install --stage-ownership --source-revision "\$\{SQUAD_SHA\}" \|\| exit 1/g))
        .toHaveLength(2);
      expect(content).toContain('Never force-add a directory or glob');
    });

    it('never auto-merges and defers automatic casting until after the bootstrap PR merges', () => {
      expect(content).toMatch(/auto-?merge/i);
      expect(content).toMatch(/never merge|do not merge|human-reviewed|human approval/i);
      expect(content).toContain('squad-bootstrap');
      expect(content).toContain('[Agentic Research] owner/repo — initial proposals');
    });

    it('pins and verifies the package-capable gh-aw compiler', () => {
      expect(content).toContain('gh_aw_version_output="$(gh aw --version 2>&1)"');
      expect(content).toContain('gh extension remove gh-aw');
      expect(content).toContain('required_gh_aw_version="v0.91.5"');
      expect(content).toContain('gh extension install --pin "${required_gh_aw_version}" github/gh-aw');
      expect(content).toContain('never select a newer release');
      expect(content).toContain('PowerShell');
    });

    it('resolves repo identity at runtime (no hardcoded owner/repo placeholder)', () => {
      expect(content).toContain('gh repo view --json nameWithOwner');
      expect(content).toContain('gh repo view --json defaultBranchRef');
    });

    it('names the bootstrap job\'s own PR-creation fallback branch as the real Cast branch, distinct from the human-run install branch', () => {
      // Regression for a Copilot review finding: this paragraph explains what
      // happens when the *automated* bootstrap workflow's own
      // github.rest.pulls.create call is refused (can_approve_pull_request_reviews
      // false). That fallback always pushes BOOTSTRAP_BRANCH
      // (workflows/shared/squad-bootstrap-validator.mjs), never the branch a
      // human creates by hand in step 2 below (chore/squad-gh-aw-bootstrap).
      // Conflating the two makes the compare URL example wrong and leaves an
      // operator looking at the wrong branch.
      const validatorSource = readLF('workflows/shared/squad-bootstrap-validator.mjs');
      const bootstrapBranchMatch = validatorSource.match(/^export const BOOTSTRAP_BRANCH = '([^']+)';$/m);
      expect(bootstrapBranchMatch, 'BOOTSTRAP_BRANCH constant must exist').not.toBeNull();
      const bootstrapBranch = bootstrapBranchMatch![1];
      expect(bootstrapBranch).toBe('squad/bootstrap-cast');

      const paragraphStart = content.indexOf("With it `false`, the bootstrap job's own");
      const paragraphEnd = content.indexOf('\n\n', paragraphStart);
      expect(paragraphStart, 'fallback-explanation paragraph must exist').toBeGreaterThan(-1);
      const paragraph = content.slice(paragraphStart, paragraphEnd);

      expect(paragraph).toContain(`\`${bootstrapBranch}\` branch`);
      expect(paragraph).toContain(`.../compare/<base>...${bootstrapBranch}?expand=1&title=...`);
      // Mutation guard: the paragraph must not (re-)claim the automated
      // fallback pushes the human's own manual install branch.
      expect(paragraph).not.toContain('pushes the\n`chore/squad-gh-aw-bootstrap` branch');
      expect(paragraph).not.toMatch(/compare\/<base>\.\.\.chore\/squad-gh-aw-bootstrap/);
    });
  });

  describe('gh-aw bootstrap documentation', () => {
    const guide = readLF(GUIDE);
    const agentGuide = readLF(AGENT_GUIDE);
    const versionGate = extractVersionGate(guide);

    it('accepts an existing exact v0.91.5 installation without reinstalling', () => {
      const result = runVersionGate(versionGate, 'v0.91.5', 'v0.91.5');
      expect(result.status).toBe(0);
      expect(result.stderr.match(/^CALL version$/gm)).toHaveLength(1);
      expect(result.stderr).not.toContain('CALL remove');
      expect(result.stderr).not.toContain('CALL install');
    });

    it('captures exact v0.91.5 version output emitted on stderr', () => {
      const result = runVersionGate(versionGate, 'v0.91.5', 'v0.91.5', 'stderr');
      expect(result.status).toBe(0);
      expect(result.stderr.match(/^CALL version$/gm)).toHaveLength(1);
      expect(result.stderr).not.toContain('CALL remove');
      expect(result.stderr).not.toContain('CALL install');
    });

    it('removes pre-existing v0.89.21 and verifies a clean v0.91.5 install', () => {
      const result = runVersionGate(versionGate, 'v0.89.21', 'v0.91.5');
      expect(result.status).toBe(0);
      expect(result.stderr.match(/^CALL version$/gm)).toHaveLength(2);
      expect(result.stderr.match(/^CALL remove$/gm)).toHaveLength(1);
      expect(result.stderr.match(/^CALL install --pin v0\.91\.5$/gm)).toHaveLength(1);
    });

    it('fails closed when a clean reinstall persistently reports v0.89.21', () => {
      const result = runVersionGate(versionGate, 'v0.89.21', 'v0.89.21');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('required gh-aw v0.91.5, but found v0.89.21');
      expect(result.stderr.match(/^CALL version$/gm)).toHaveLength(2);
      expect(result.stderr.match(/^CALL remove$/gm)).toHaveLength(1);
      expect(result.stderr.match(/^CALL install --pin v0\.91\.5$/gm)).toHaveLength(1);
      expect(guide.indexOf(VERSION_GATE_END)).toBeLessThan(
        guide.indexOf('git switch -c chore/squad-gh-aw-bootstrap'),
      );
      expect(guide.indexOf(VERSION_GATE_END)).toBeLessThan(
        guide.indexOf(INSTALL_COMMAND),
      );
    });

    it('keeps the canonical skill version gate synchronized with the guide', () => {
      expect(extractVersionGate(readLF(CANONICAL))).toBe(versionGate);
    });

    it('checks the staged installation before every bootstrap commit', () => {
      expect(guide.match(/--verify-staged-install --stage-ownership --source-revision "\$\{SQUAD_SHA\}" \|\| exit 1/g))
        .toHaveLength(2);
    });

    it('removes the mutable gh-aw router before verification and permits only the documented staged deletions', () => {
      expect(guide.match(/rm -f \.github\/skills\/agentic-workflows\/SKILL\.md/g))
        .toHaveLength(3);
      const flatGuide = guide.replace(/\s+/g, ' ');
      expect(flatGuide).toContain(
        'The only permitted staged deletions are the exact router deletion above',
      );
      expect(flatGuide).toContain(`the superseded \`${LEGACY_OWNERSHIP}\` ownership record`);
      expect(flatGuide).toContain('Any other deletion is a hard stop.');
      expect(guide.split(DELETION_FILTER).length - 1, 'both guide staging gates must use the skill filter')
        .toBe(2);
      expect(guide).toContain('.github/skills/gh-aw-enlistment/SKILL.md');
      expect(agentGuide).toContain('rm -f .github/skills/agentic-workflows/SKILL.md');
    });

    it('advertises only the canonical package identity on every public install surface', () => {
      for (const [path, text] of [
        [GUIDE, guide],
        [AGENT_GUIDE, agentGuide],
        ['README.md', readLF('README.md')],
      ] as const) {
        expect(text, `${path} must install ${PACKAGE_NAME}`).toContain(INSTALL_COMMAND);
        for (const block of fencedBlocks(text)) {
          expect(block, `${path}: no executable block may install the legacy ${LEGACY_PACKAGE_NAME} identity`)
            .not.toContain(LEGACY_INSTALL_PREFIX);
        }
      }
      expect(guide).toContain(`# (${SQUAD_INIT_ACTION}) and nothing else. STOP and`);
      expect(guide).toContain(`- Action: \`${SQUAD_INIT_ACTION}\``);
      expect(guide.replace(/\s+/g, ' ')).toContain(
        `At a revision whose manifest declares \`${LEGACY_PACKAGE_NAME}\`, the same action is reported as `
        + '`bradygaster/squad/.github/actions/squad-init`.',
      );
      expect(guide).toContain(`\`${PACKAGE_NAME}@SHA\` for direct package includes`);
      expect(guide).toContain(`\`${PACKAGE_NAME}/package/<workflow>.md@SHA\` when installing dispatched`);
    });

    it('runs the skill\'s identity gate before every guide and README install command', () => {
      const gate = extractIdentityGate(readLF(CANONICAL));
      expect(extractIdentityGate(guide), 'the guide quick-start gate must match the skill').toBe(gate);
      const readme = readLF('README.md');
      for (const [path, text, copies] of [[GUIDE, guide, 3], ['README.md', readme, 1]] as const) {
        expect(text.split(gate).length - 1, `${path} identity gate copies`).toBe(copies);
        const installs = fencedBlocks(text).filter(block => block.includes(INSTALL_COMMAND));
        expect(installs, `${path} install blocks`).toHaveLength(copies);
        for (const block of installs) {
          expect(block.indexOf(gate), `${path}: every install block must run the identity gate`).toBeGreaterThan(-1);
          expect(block.indexOf(gate), `${path}: the identity gate must precede gh aw add`)
            .toBeLessThan(block.indexOf(INSTALL_COMMAND));
        }
      }
    });

    it('states which revisions verify the canonical identity on every install surface', () => {
      for (const [path, text] of [
        [GUIDE, guide],
        [AGENT_GUIDE, agentGuide],
        ['README.md', readLF('README.md')],
        ['workflows/README.md', readLF('workflows/README.md')],
      ] as const) {
        const flat = text.replace(/\s+/g, ' ');
        expect(flat, `${path} must state the manifest cutoff`).toContain(MANIFEST_RULE);
        expect(flat, `${path} must route older revisions to the legacy identity`)
          .toMatch(/older (?:maintainer-)?approved revision (?:as|under that identity|declares)/);
        expect(flat, `${path} must offer a newer revision`).toMatch(/ask the (?:Squad )?maintainers for a newer revision/);
      }
    });

    it('requires agents to execute the complete quick start through PR creation', () => {
      expect(guide).toContain('**Agent action required:**');
      expect(guide).toContain('the agent must execute this entire block');
      expect(guide).toContain('gh pr create');
      expect(agentGuide).toContain('execute the complete');
      expect(agentGuide).toContain('Do not only quote or run the `gh aw add` command');
    });

    it('resolves the repository dynamically before changing Actions permissions', () => {
      expect(guide).toContain(
        'owner_repo="$(gh repo view --json nameWithOwner --jq \'.nameWithOwner\')"',
      );
      expect(guide).toContain(
        'gh api --method PUT "repos/${owner_repo}/actions/permissions/workflow"',
      );
      expect(guide).not.toContain('repos/{owner}/{repo}/actions/permissions/workflow');
    });

    it('requires Issues before installation and documents the admin-permission stop', () => {
      const issuesCheck = guide.indexOf(
        'issues_enabled="$(gh api "repos/${owner_repo}" --jq \'.has_issues\')"',
      );
      expect(issuesCheck).toBeGreaterThan(-1);
      expect(guide).toContain('-F has_issues=true --silent');
      expect(guide).toContain('requires repository administration permission');
      expect(guide).toContain('do not continue to `gh aw add`');
      expect(issuesCheck).toBeLessThan(guide.indexOf('git switch -c chore/squad-gh-aw-bootstrap'));
      expect(issuesCheck).toBeLessThan(
        guide.indexOf(INSTALL_COMMAND),
      );
      expect(agentGuide).toContain('verifies that GitHub Issues are enabled');
      expect(agentGuide).toContain('bootstrap creates a research/proposals issue');
    });

    it('keeps standalone public install snippets behind the Issues guard', () => {
      const readme = readLF('README.md');
      const readmeInstall = readme.slice(readme.indexOf('### Install'));
      expect(readmeInstall.indexOf("issues_enabled=")).toBeGreaterThan(-1);
      expect(readmeInstall.indexOf("issues_enabled=")).toBeLessThan(
        readmeInstall.indexOf(INSTALL_COMMAND),
      );
      expect(readmeInstall).toContain(
        'test "$(gh api "repos/${owner_repo}" --jq \'.has_issues\')" = "true" || {',
      );

      const setupSection = guide.slice(
        guide.indexOf('### Enable GitHub Issues'),
        guide.indexOf('### Set Actions pull-request permissions (Profile A, recommended)'),
      );
      expect(setupSection).toContain(
        'test "$(gh api "repos/${owner_repo}" --jq \'.has_issues\')" = "true" || {',
      );
    });

    it('activates slash commands only after the bootstrap PR reaches the default branch', () => {
      expect(guide).toContain(
        'Once the bootstrap PR is merged into the default branch, the `/squad` slash',
      );
      expect(guide).toContain('Pushing the bootstrap branch or merely opening the');
      expect(guide).not.toContain('Once pushed, the `/squad` slash command is live');
      expect(agentGuide).toContain(
        '`/squad` slash commands become active only after that merge reaches',
      );
    });

    it('documents the native required review job without a credential prerequisite', () => {
      const flatGuide = guide.replace(/\s+/g, ' ');
      expect(flatGuide).toContain('stable required status context `Squad Review / review`');
      expect(guide).toContain('No custom Checks API publisher');
      expect(flatGuide).toContain('same-name source-identity question');
      expect(flatGuide).toContain('context-only `Squad Review / review` requirement is advisory');
      expect(agentGuide).toContain('requires no separate PAT');
      expect(guide).not.toMatch(/SQUAD_REVIEW_APP_|squad-review-authority/);
      expect(agentGuide).not.toMatch(/SQUAD_REVIEW_APP_|squad-review-authority/);
    });

    it('makes public-guide package verification fail fast and coherent', () => {
      expect(guide).toContain(INSTALL_COMMAND);
      expect(guide).toContain('squad-install-verifier.mjs --materialize-runtime');
      expect(guide).toContain('--verify-install');
      expect(guide).toContain('--source-revision "${SQUAD_SHA}"');
      expect(guide).toContain('--strict-compile');
      expect(guide).toContain('package ownership metadata');
      const upgrade = guide.slice(guide.indexOf('## Upgrading'));
      const add = upgrade.indexOf(`${INSTALL_COMMAND} --force`);
      const cleanup = upgrade.indexOf('rm -f .github/skills/agentic-workflows/SKILL.md');
      const legacyCleanup = upgrade.indexOf(`rm -f ${LEGACY_OWNERSHIP}\n`);
      const compile = upgrade.indexOf('gh aw compile --strict');
      const verify = upgrade.indexOf('squad-install-verifier.mjs \\\n  --verify-install');
      expect(add).toBeGreaterThan(-1);
      expect(cleanup).toBeGreaterThan(add);
      expect(legacyCleanup, `Upgrading must delete the superseded ${LEGACY_OWNERSHIP}`).toBeGreaterThan(add);
      expect(compile).toBeGreaterThan(cleanup);
      expect(compile).toBeGreaterThan(legacyCleanup);
      expect(verify).toBeGreaterThan(compile);
      const flatUpgrade = upgrade.replace(/\s+/g, ' ');
      expect(flatUpgrade).toContain('the verifier fails closed while both records exist');
      expect(flatUpgrade).toContain(
        `action \`${SQUAD_INIT_ACTION}\` added and \`bradygaster/squad/.github/actions/squad-init\` removed.`,
      );
      const gate = extractIdentityGate(readLF(CANONICAL));
      expect(upgrade.indexOf(gate), 'Upgrading must run the identity gate').toBeGreaterThan(-1);
      expect(upgrade.indexOf(gate), 'Upgrading must check the identity before reinstalling').toBeLessThan(add);
      expect(flatUpgrade, 'Upgrading must say how to stay on a legacy-only revision').toContain(
        `with \`${LEGACY_INSTALL_PREFIX}\${SQUAD_SHA}" --force\`, and skip the second \`rm -f\`: `
        + 'that ownership record is the only one such an installation has.',
      );
    });
  });

  describe('template mirror parity', () => {
    for (const mirror of MIRRORS) {
      it(`${mirror} is byte-for-byte identical to the canonical source`, () => {
        expect(existsSync(resolve(ROOT, mirror)), `${mirror} should exist`).toBe(true);
        expect(readFileSync(resolve(ROOT, mirror)).equals(readFileSync(resolve(ROOT, CANONICAL)))).toBe(true);
      });
    }
  });
});
