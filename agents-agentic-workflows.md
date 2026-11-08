# Squad agentic workflows bootstrap prompt

**Compatibility status:** gh-aw 1.x is the intended target, without an exact patch-version lock. It is not yet a verified Squad installation path: v1.0.1 installs and strictly compiles the upstream package, but the current verifier rejects its package ownership and compiler contract. Do not use compilation success alone as installation approval. See the [compatibility findings](https://github.com/github/squad/blob/dev/docs/src/content/docs/guide/gh-aw.md#gh-aw-1x-compatibility).

```text
Bootstrap this repository with GitHub's Squad agentic workflows from `github/squad`. Inspect the repo first, make only the necessary changes, validate them, and open a PR for human review if your tools permit it. Do not merge.

Before editing:
- Check the default branch, working tree, authentication, and existing `.github/aw/`, `.github/workflows/`, and `.github/skills/` files.
- If an installation is already present, or files conflict and you can't verify their ownership, stop and report the paths; don't overwrite them.
- Check `gh aw --version` against current official stable 1.x releases. Do not install an exact patch version or downgrade to 0.x to bypass a failed prerequisite.
- Obtain an approved, immutable 40-character lowercase `SQUAD_SHA` from published guidance or a maintainer. Never guess or use a moving branch.
- Require published compatibility evidence for that revision, `github/squad/workflows` ownership, and the installed 1.x compiler. The current package still binds ownership to `bradygaster/squad/workflows`, requires v0.91.5 compiler/action pins, and verifies complete compiled-lock digests. Until those contracts are migrated and validated together, STOP before installation and report the incompatibility. Do not rewrite ownership, regenerate trusted digests in the consumer repo, or weaken the verifier.
- Check that Issues are enabled and Actions permissions match the documented Profile A (`default_workflow_permissions=read`, `can_approve_pull_request_reviews=false`). Don't change settings without explicit authorization.

Only after every prerequisite passes, install on `chore/squad-gh-aw-bootstrap`, without overwriting existing work:
`gh aw add "github/squad/workflows@${SQUAD_SHA}"`

Do not run generic `gh aw init` or create Squad files by hand. If the install generates `.github/skills/agentic-workflows/SKILL.md`, remove only that tool-generated file as the guide directs. Don't create the optional secrets. If a first-install safe-update approval is required, compare its exact secret/action list with the approved revision's published guidance. The intended upstream list is exactly `SQUAD_GITHUB_APP_PRIVATE_KEY`, `SQUAD_GITHUB_TOKEN`, and `github/squad/.github/actions/squad-init`; the current package instead references the fork's action and does not satisfy this prerequisite. Stop on any mismatch; do not approve or substitute an action.

Run and require success:
1. `node .github/workflows/shared/squad-install-verifier.mjs --materialize-runtime`
2. `gh aw compile --strict`
3. `node .github/workflows/shared/squad-install-verifier.mjs --verify-install --source-revision "${SQUAD_SHA}" --strict-compile`
4. Stage only newly installed/materialized changed/owned paths within `.gitattributes`, `.github/aw/`, `.github/workflows/`, and `.github/skills/`; never stage whole directories containing unrelated files. Review the staged diff, then run `node .github/workflows/shared/squad-install-verifier.mjs --verify-staged-install --stage-ownership --source-revision "${SQUAD_SHA}"`.

Confirm eight workflows and their generated lockfiles are present and review the compiled artifacts. Require the approved revision's documented warning policy for the installed compiler; do not assume the legacy v0.91.5 warning allowlist applies to 1.x. Stop on any undocumented warning, error, unexpected deletion, or unrelated change. Review the staged diff before committing.

Open a PR against the default branch captured during inspection only after all checks pass. If you can't verify a prerequisite, validate the install, push, or create the PR, report the exact blocker instead of claiming success. Report the PR URL and validation results if created; leave merge and post-merge activation to a human.
```
