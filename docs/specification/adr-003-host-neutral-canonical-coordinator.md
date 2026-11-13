# ADR 003: Host-Neutral Canonical Coordinator in the Workspace

**Status:** Proposed

**Tracking:** [#2438](https://github.com/github/squad/issues/2438) (Phase 7)

**Affects:** `squad-client-harness-adapters/v0.2` §4–§5 (projection contract
and canonical paths) and §13 (upgrade and rollback)

This ADR records a decision to be made. It does not change any code. Merging it
with status Proposed does not approve it.

## Context

### Where the coordinator lives today

In this repository the coordinator's source is already host-neutral:
`.squad-templates/squad.agent.md`, copied by `scripts/sync-templates.mjs` into
`templates/`, `packages/squad-cli/templates/` and
`packages/squad-sdk/templates/`.

In a **user workspace**, the only full copy is the Copilot one.
`squad init` writes `.github/agents/squad.agent.md` (about 80 KB), and
`CANONICAL_COORDINATOR_AGENT_PATH` in
`packages/squad-sdk/src/client/adapters/coordinator.ts` points at it. Every
other host gets a compact digest (under 24 KB, enforced by
`test/clients.test.ts`) that says:

- `.github/agents/squad.agent.md` is the authoritative coordinator contract;
- when that file exists in the workspace, read it.

So a Claude Code, Kiro, OpenCode, Cursor, Codex or Antigravity coordinator
depends on a file that lives under a Copilot-specific path and is shaped for
Copilot. A workspace that projects only non-Copilot hosts still gets
`.github/agents/squad.agent.md`, because `squad init` always writes it.

### Why it matters now

Epic #2438 makes Claude Code a first-class host. Phase 4 of that epic slims the
Claude coordinator by moving on-demand sections into Claude skills. How far
that can go depends on what the Claude coordinator is told is authoritative:
while the answer is "the Copilot file", the Claude coordinator may still read
80 KB of Copilot-shaped text on demand, which undercuts the slimming.

## Options

### A. Keep the canonical file at `.github/agents/squad.agent.md` (status quo)

- No migration. Copilot surfaces keep discovering it where they do today.
- Non-Copilot hosts keep pointing at a Copilot path. Phase 4 slims only what
  the Claude coordinator loads by default, not what it treats as authoritative.

### B. Move the canonical file to a host-neutral workspace path and generate Copilot's from it

For example `.squad/coordinator.md` (inside the team directory) or a path
under `.squad-templates/` in the workspace.

- Every host, Copilot included, becomes a projection of one host-neutral
  source, which matches how the other six hosts already work.
- `.github/agents/squad.agent.md` is still written for Copilot, generated from
  the neutral source. Copilot discovery is unchanged.
- The digests point at the neutral path instead of the Copilot one.
- This is a projection-version change (harness-adapters §5) for every host,
  and needs a migration in `squad upgrade`.

### C. Keep the Copilot file canonical, but stop pointing non-Copilot hosts at it

- Each host's digest becomes self-sufficient, with on-demand sections served
  by host-native mechanisms (Claude skills, Kiro steering, and so on).
- No new file. The canonical contract remains defined only for Copilot, so
  keeping the hosts' behavior in step relies on the digest parity tests alone.

## Constraints on any choice

- **Copilot output stays byte-identical.** If B is chosen, the generated
  `.github/agents/squad.agent.md` must match today's bytes, checked by the
  Copilot snapshot in `test/host-projection-regression-guards.test.ts`.
- **Copilot discovery is unaffected.** Copilot CLI, the Copilot app and VS Code
  auto-discover `.github/agents/`; that file must keep being written wherever
  Copilot is configured.
- **Upgrade and rollback stay byte-preserving** (harness-adapters §13): a user
  who never opts in to a non-Copilot host sees no change.
- **The behavioral-contract parity tests keep passing** for every host.

## Open questions

1. Is moving the canonical file off the Copilot path acceptable for the Copilot
   surfaces that auto-discover `.github/agents/`, given that the generated file
   stays in place?
2. If B: should the neutral file live inside the team directory (`.squad/`),
   where it can be served by `squad_state_read` and follows `teamRoot` in
   remote mode, or outside it?
3. If B: is the Copilot file still written for workspaces where Copilot is not
   in `clients[]`?

## Analysis (2026-11-12)

Input for the decision, not the decision itself.

### Evidence: the pointer is not followed

The "Why it matters now" concern is that a non-Copilot coordinator may read
80 KB of Copilot-shaped text on demand. Local Claude Code transcripts for Squad
test repositories (2026-11-10 to 2026-11-12, Claude Code 2.1.317–2.1.318) were
checked for any Read, Bash, Grep or Glob call on
`.github/agents/squad.agent.md`. None of the 43 sessions (223 tool calls)
touched it. Most of those sessions are short probes. Seven did real team
work: the end-to-end test and a fresh `squad init --client claude` repository
cast and built through `claude -p --agent squad`. Those seven made 177 tool
calls, 32 member spawns and 96 `squad_state` or `.squad/` accesses. In both
repositories the 82–83 KB Copilot file was present and the digest pointed at
it. The coordinators worked from their digest, skills and `squad_state`.

This is a strong signal, not proof: seven sessions, one model family, one
Claude Code version, and a longer session (a ceremony, Ralph mode) could still
follow the pointer. The method, a table and the script are on
[#2469](https://github.com/github/squad/issues/2469#issuecomment-6831645352).
Still, the cost that option B removes is mostly theoretical today.

### What B gains

- One host-neutral source with every host as a projection of it. This matches
  how the other six hosts already work and how harness-adapters §4–§5
  describes projection.
- No host's digest names a Copilot path as its authority.
- If the neutral file lives under `.squad/`, `squad_state_read` can serve it,
  and it follows `teamRoot` in remote mode.
- Not writing `.github/agents/squad.agent.md` for repositories without Copilot
  (open question 3, and #2458) is sometimes counted as a gain of B. It does
  not depend on moving the canonical file, and can be decided on its own.

### What B risks

- **Copilot users carry the risk.** The workspace file is not a plain template
  copy. It carries a version stamp; `squad cast` writes the team-capabilities
  block into it (#1608), which outer coordinators read; and `squad upgrade`
  backs up local customizations to `.local-backup` (#1052), so users do edit
  it. A generated Copilot file must reproduce all of this and stay
  byte-identical (the Copilot snapshot in
  `test/host-projection-regression-guards.test.ts`).
- **Customizations.** Edits to a generated file are overwritten on the next
  refresh. Users with a customized file need a migration path and a clear
  message.
- **Placement.** In a monorepo, `squad init` writes the Copilot file at the git
  root while `.squad/` can sit in a subfolder, and remote mode moves the team
  root. A neutral file and the Copilot file it generates are not always
  side by side.
- **Churn.** It is a projection-version change for all seven hosts, so every
  repository gets a diff on its next `squad upgrade`. Rollback must stay
  byte-preserving (§13), and the upgrade matrix needs re-recording on Linux and
  Windows.
- **Drift.** Users who keep editing the generated Copilot file create a second
  copy that diverges from the neutral source.

### Scope

- **Option B:** about 2–3 days. The canonical path appears in about 20 source
  files (init, upgrade, cast, team capabilities, the legacy fallback, help text
  and the adapter contract) and 44 test files. The work: the neutral file and a
  generator that keeps Copilot output byte-identical (stamp and capabilities
  block included); the upgrade migration and rollback, with customized files;
  monorepo and remote placement; a projection version bump for every host; a
  regenerated Claude plugin and a re-recorded upgrade matrix; spec and docs.
- **Option C:** about half a day. Rewrite the "Authoritative specification"
  paragraph in `coreCoordinatorProtocol` (`coordinator.ts`) so each digest is
  self-sufficient (Claude already serves on-demand sections as skills), update
  the digest parity tests, and regenerate. No migration, and no change to
  Copilot output.
- **Not writing the Copilot file without Copilot** (separate from both):
  small, but a behavior change that needs its own decision.

### Recommendation

Choose C now and defer B. C removes the dependency on a Copilot path at almost
no risk. B is worth revisiting if a single source starts to matter: for
example, if Copilot's file needs host-specific content, or remote teams need
the coordinator served through `squad_state`. Neither choice gates a release.

### Team direction (2026-11-12)

Maintainer discussion favored C for 2.0 and B only as a bounded, opt-in
experiment ([summary](https://github.com/github/squad/issues/2469)). It also
noted that the session evidence shows which files were read, not that the
coordinator behaves correctly, so C must be shown with behavioral scenarios run
with the Copilot file absent. C is tracked in
[#2487](https://github.com/github/squad/issues/2487) and the B spike in
[#2488](https://github.com/github/squad/issues/2488). This records the
discussion; it does not accept this ADR.

## Decision

Not yet made. Implementation, if approved, is a separate PR with its own
projection version bump and CHANGELOG entry.

## Related artifacts

- [Squad Client and Harness Adapter Profile v0.2](client-harness-adapters-v0.2.md)
- [ADR 001: Client, Control, and Execution Boundary](adr-001-client-control-execution-boundary.md)
- `packages/squad-sdk/src/client/adapters/coordinator.ts`
- `scripts/sync-templates.mjs`
