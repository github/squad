# Release Process for Squad Maintainers

Squad has three automated release channels:

| Channel | Source | Version | npm tag | Package managers |
|---------|--------|---------|---------|------------------|
| Insider | Manual insider dispatch from `dev` | `X.Y.Z-insider.N` | `insider` | Homebrew and WinGet |
| Preview | Manual release dispatch from `dev` (exact SHA) | `X.Y.Z-preview.N` | `insider` (+ `preview` alias) | Held |
| Stable | Sanitized promotion to `main` | `X.Y.Z` | `latest` | Homebrew and WinGet |

There is no staging `preview` branch. The word preview refers to a GitHub
prerelease and npm dist-tag.

## Prepare the version

Create a normal release-preparation PR targeting `dev`. Keep the root, SDK, and
CLI versions in lockstep:

```bash
VERSION=2.0.0-preview.4
npm version "$VERSION" --workspaces --include-workspace-root --no-git-tag-version
npm pkg set "dependencies.@bradygaster/squad-sdk=>=$VERSION" \
  --workspace @bradygaster/squad-cli
npm install --package-lock-only
```

Add an exact changelog heading:

```markdown
## [2.0.0-preview.4] - YYYY-MM-DD
```

Before merging, verify:

```bash
node -p "require('semver').valid('$VERSION')"
grep '"version"' package.json packages/squad-sdk/package.json packages/squad-cli/package.json
grep -F "## [$VERSION]" CHANGELOG.md
grep -F "## v$VERSION" docs/src/content/docs/whatsnew.md
SKIP_BUILD_BUMP=1 npm run build
npx vitest run
```

Wait for `dev` CI to pass after the PR merges.

## Publish a preview

Use a unique prerelease version such as `2.0.0-preview.4`. The release trigger
is human-only and pins the exact reviewed commit:

```bash
VERSION=2.0.0-preview.4
SHA=$(git rev-parse origin/dev)   # the reviewed dev tip, full 40-hex SHA
gh workflow run squad-release.yml \
  --ref dev \
  -f confirm_tag="v$VERSION" \
  -f expected_sha="$SHA" \
  -f npm_dist_tag=insider \
  -f add_preview_alias=true \
  -f publish_standalone=true \
  -f publish_package_managers=false
gh run watch
```

For `2.0.0-preview.4`, reviewers and release owners explicitly hold Homebrew,
WinGet, `latest`, and stable promotion. This dispatch publishes the npm pair
(`insider` canonical plus the `preview` alias) and standalone artifacts only.
`publish_package_managers=false` is required for this release; there is no
preview.4 package-manager installation path.

Optional inputs: `npm_dist_tag` (`insider`, the default, or `preview`),
`add_preview_alias` (default `true`), `build_standalone` (default `true`),
`publish_standalone` (default `false`) and `publish_package_managers`
(default `false`).

The workflow refuses to run unless the dispatch SHA, the workflow definition
SHA, the checkout and the live `dev` tip all equal `expected_sha`, and the
version is not stable. It then:

1. Runs the full verification bundle at that SHA
   (`squad-release-verify.yml`: lockfile registry gate, clean external
   `npm ci`, build, lint, full test suite with a JSON report and skip/todo/xfail
   reconciliation, docs build, release policy gates, pack evidence with a
   privacy scan, isolated-prefix install, verification manifest + provenance).
2. Re-asserts the SHA, creates the immutable tag (an existing tag must already
   target the SHA) and a **draft** GitHub prerelease.
3. Publishes the SDK and CLI as a pair: both are staged under a per-run
   dist-tag, verified (version, integrity, CLI→SDK pin, isolated install),
   promoted together to `insider`, then `preview` is added as an alias; a final
   two-package reconciliation fails the run as `PARTIAL_PUBLISH` or `UNKNOWN`
   if either package is missing or unconfirmed.
4. Preflights Homebrew and WinGet authentication plus push access before the
   tag, npm, release, or standalone publication when package managers are
   selected.
5. Builds standalone archives for macOS, Linux and Windows as workflow
   artifacts. They are attached to the release, and `squad-preview` /
   `bradygaster.Squad.Preview` are updated, only when `publish_standalone`
   and `publish_package_managers` are set.
6. Publishes the GitHub prerelease only after npm reconciles `COMPLETE` and
   every selected standalone, Homebrew, and WinGet channel completes.

If a registry read times out the outcome is `UNKNOWN`, not a failure to
publish. Recovery is allowed only from the immutable tag and requires the run
ID plus exact `release-evidence-<sha>` artifact from a successful Squad Release
Verify run at that SHA. It publishes only a genuinely missing package and
otherwise reconciles idempotently.

Release evidence must show that the published CLI tarball pins the SDK to the
exact same version, even though the workspace manifest keeps a prerelease
dependency floor while developing on `dev`.

Install the preview from npm with:

```bash
npm install -g @bradygaster/squad-cli@insider   # canonical self-upgrade channel
npm install -g @bradygaster/squad-cli@preview   # compatibility alias
```

Homebrew and WinGet are intentionally unavailable for preview.4.

Do not dispatch `squad-insider-publish.yml` for a prepared preview version: it
computes and publishes its own `X.Y.Z-insider.N` snapshot version.

## Publish an insider snapshot

Dispatch the insider workflow from `dev`:

```bash
gh workflow run squad-insider-publish.yml --ref dev -f dry_run=false
gh run watch
```

The workflow computes the next immutable `X.Y.Z-insider.N` version, publishes
both npm packages, creates a GitHub prerelease, uploads standalone archives,
updates `squad-insider` in Homebrew, and opens or reuses the
`bradygaster.Squad.Insider` WinGet PR.

## Publish stable

Prepare a PR targeting `dev` that sets the root, CLI and SDK versions to
`2.0.0`, sets the CLI SDK floor to `>=2.0.0`, regenerates the Claude plugin,
and adds `## [2.0.0] - 2026-11-18` to the changelog. Preserve historical preview
entries: `2.0.0-preview.4` and `2.0.0` are different immutable releases.
Reconcile current `main` into the preparation branch and audit its recent docs,
release authentication and repository-identity changes before promotion.

After the stable preparation lands on `dev`, a human must run the promotion
validation. This is not agent-safe: `squad-promote.yml` grants
`actions: write` and `contents: write`, checks out `dev` with the workflow
token, installs dependencies, and runs the release build and tests.

```bash
gh workflow run squad-promote.yml --ref dev -f dry_run=true
gh run watch
```

Only a human may then run the live promotion. **Without `promotion_branch`,
this command pushes `main` and immediately dispatches the full stable release,
including standalone and package-manager publication.** It is not a
PR-only operation and must not be used to bypass branch protection:

```bash
gh workflow run squad-promote.yml --ref dev -f dry_run=false
gh run watch
```

The promotion workflow merges `dev` directly into `main`, removes internal team
state from the release tree, validates versions and the changelog, builds, runs
tests, and pushes `main`.

For a protected-main PR path, first prepare and validate a sanitized
`chore/promote-2.0.0` branch in the upstream repository. A human can then have
the workflow validate and open that existing branch as a PR:

```bash
gh workflow run squad-promote.yml --ref dev \
  -f dry_run=true -f promotion_branch=chore/promote-2.0.0
gh run watch
gh workflow run squad-promote.yml --ref dev \
  -f dry_run=false -f promotion_branch=chore/promote-2.0.0
gh run watch
```

Wait for required checks and reviews before merging the promotion PR.
`squad-release.yml` is manual-only; a normal PR merge does not publish.
After the reviewed promotion reaches `main`, a human reads its exact tip and
dispatches the release:

```bash
SHA=$(gh api repos/github/squad/git/ref/heads/main --jq '.object.sha')
gh workflow run squad-release.yml --ref main \
  -f confirm_tag=v2.0.0 -f expected_sha="$SHA" \
  -f build_standalone=true -f publish_standalone=true \
  -f publish_package_managers=true
gh run watch
```

The explicit publication flags match the stable release checklist: defaults
only build standalone artifacts and do not publish them or promote the GitHub
Release to latest. The legacy direct-push path already dispatches this release;
do not dispatch a second run while it is active.

The release workflow verifies the exact SHA, creates the stable tag and a draft
GitHub Release, publishes npm `latest`, uploads standalone archives, updates the
Homebrew cask and opens or reuses the WinGet manifest PR. It publishes the
GitHub Release and marks it latest only after the selected channels complete.

## What gets removed from `main`

The promotion workflow strips:

```text
.ai-team/
.squad/
.ai-team-templates/
team-docs/
docs/proposals/
```

Those paths remain on `dev`; no force push or staging branch is needed.

## Verify a release

For preview (both tags must point at the version for both packages):

```bash
npm view @bradygaster/squad-sdk dist-tags.insider
npm view @bradygaster/squad-cli dist-tags.insider
npm view @bradygaster/squad-sdk dist-tags.preview
npm view @bradygaster/squad-cli dist-tags.preview
```

For stable:

```bash
npm view @bradygaster/squad-sdk dist-tags.latest
npm view @bradygaster/squad-cli dist-tags.latest
```

The values must equal the release version, and the `npm-publish-reconciliation-*`
artifact of the run must report `"outcome": "COMPLETE"`. The
`release-evidence-<sha>` artifact holds the exact tarballs, their sha256 and
npm integrity, the verification manifest and its `provenance.json`. When
standalone publication was requested, the GitHub Release must contain six
archives and `SHA256SUMS.txt`, and the channel must update its Homebrew cask
and create or reuse its WinGet PR:

| Channel | Homebrew cask | WinGet identifier |
|---------|---------------|-------------------|
| Insider | `squad-insider` | `bradygaster.Squad.Insider` |
| Preview | `squad-preview` | `bradygaster.Squad.Preview` |
| Stable | `squad` | `bradygaster.Squad` |

## Recover a failed publication

Do not recreate the tag or GitHub Release. The publish workflow uses
fail-closed reconciliation with idempotent partial-release recovery. A registry
timeout is an `UNKNOWN` outcome, not proof that a package is missing. The rerun
checks version and integrity first and publishes only what is genuinely absent:

```bash
VERSION=2.0.0
SHA=$(git rev-list -n 1 "v$VERSION")   # the tag target; the branch may have moved on
VERIFY_RUN_ID=<successful-release-verify-run-id>
EVIDENCE_ARTIFACT="release-evidence-$SHA"
gh workflow run squad-npm-publish.yml --ref "v$VERSION" \
  -f version="$VERSION" -f source_sha="$SHA" -f dist_tag=latest \
  -f verify_run_id="$VERIFY_RUN_ID" -f evidence_artifact="$EVIDENCE_ARTIFACT"
gh workflow run squad-standalone-release.yml --ref "v$VERSION" \
  -f upload=true -f release_tag="v$VERSION" -f source_ref="$SHA" -f source_sha="$SHA"
```

Use the preview tag ref and `-f dist_tag=insider -f add_preview_alias=true` for
preview-release recovery. A tag that points at a different commit than
`source_sha`, a non-successful verify run, or mismatched evidence fails the run;
tags are never moved.

## After stable

Open a normal PR to `dev` that sets the next development version, for example:

```bash
NEXT_VERSION=1.3.0-preview.1
npm version "$NEXT_VERSION" --workspaces --include-workspace-root --no-git-tag-version
npm pkg set "dependencies.@bradygaster/squad-sdk=>=$NEXT_VERSION" \
  --workspace @bradygaster/squad-cli
npm install --package-lock-only
```
