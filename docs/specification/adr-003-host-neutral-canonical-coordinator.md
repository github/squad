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

## Decision

Not yet made. Implementation, if approved, is a separate PR with its own
projection version bump and CHANGELOG entry.

## Related artifacts

- [Squad Client and Harness Adapter Profile v0.2](client-harness-adapters-v0.2.md)
- [ADR 001: Client, Control, and Execution Boundary](adr-001-client-control-execution-boundary.md)
- `packages/squad-sdk/src/client/adapters/coordinator.ts`
- `scripts/sync-templates.mjs`
