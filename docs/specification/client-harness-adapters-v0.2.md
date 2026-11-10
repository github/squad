# Squad Client and Harness Adapter Profile v0.2

**Status:** Working Draft

**Document class:** Non-normative requirements draft

**Profile identifier:** `squad-client-harness-adapters/v0.2`

**Maturity:** Requirements draft; non-claimable

**Claimable capabilities:** None

**Implementation status:** GitHub Copilot projections exist today, and the
repository already carries portable agent, rules, and MCP artifacts, but the
full seven-host projection model is still being locked into one SDK surface.

**Known deviations:** Host discovery, approvals, session spawning, MCP config
projection, and rollback behavior vary across Copilot, Claude Code, Kiro,
OpenCode, Cursor, Codex, and Antigravity.

**Depends on:** `squad-core/v0.1`, `squad-interop/v0.1`,
`squad-client-backend-decoupling/v0.2`

## 1. Scope and non-goals

This profile defines the host-facing service provider interface that bridges
Squad's portable client plane to concrete agent hosts and execution harnesses.
It covers the `ClientAdapter` and `HarnessAdapter` contracts, the workspace
projection they expose, and the authoritative file paths each supported host
uses for agent and MCP wiring.

It does not standardize the internal tool catalog of any host, the visual
presentation of approvals, extension packaging, or provider-specific pricing
and authentication.

This profile follows the same convergence rule: adapters own native
host bootstrap, transport mechanics, event parsing, tool registration, UI
rendering, and translation to canonical envelopes. They do not own
conversation semantics, routing, durable state, authorization policy, or the
canonical command and event vocabulary.

## 2. Adapter roles

Two related adapters project the same portable conversation model:

| Adapter | Plane boundary | Responsibility |
|---|---|---|
| `HostProjection` | workspace projection only | writes, updates, and removes host-owned files without runtime or backend dependencies |
| `ClientAdapter` | client plane to broker plane | composes `HostProjection` with runtime bindings and translates host turns, approvals, and transcript subscriptions into backend calls |
| `HarnessAdapter` | broker plane to execution plane | translates portable run and task operations into the host's agent execution primitive |

`HostProjection` is pure workspace projection. It owns file creation, merge,
upgrade, and byte-preserving rollback for host artifacts, and it has zero
runtime or backend dependency. The client adapter is closest to the end-user
surface. The harness adapter is closest to spawned work, subagents, sessions,
or durable workers. Some hosts can implement all three in one package, but the
interfaces remain separate so local UI behavior does not leak into execution
or backend semantics.

The client adapter therefore ends at the host capability boundary: auth,
session bootstrap, user-visible event rendering, approval affordances, and
subscription plumbing. The harness adapter ends at the execution capability
boundary: task launch, cancellation, tool invocation mechanics, and local
lifecycle management. Everything beyond those boundaries is expressed in the
shared backend contract from `squad-client-backend-decoupling/v0.2`.

## 3. Portable TypeScript SPI

```ts
export type ClientId =
  | 'copilot'
  | 'claude'
  | 'kiro'
  | 'opencode'
  | 'cursor'
  | 'codex'
  | 'antigravity';

export interface AdapterDescription {
  adapterId: string;
  hostKind:
    | 'github-copilot'
    | 'claude-code'
    | 'kiro'
    | 'opencode'
    | 'cursor'
    | 'codex'
    | 'antigravity';
  hostVariant?: string;
  displayName: string;
  capabilities: string[];
  projectedFiles: string[];
}

export interface AdapterCapabilityProjection {
  clientCapabilities: string[];
  backendCapabilities: string[];
  policyCapabilities: string[];
  effectiveCapabilities: string[];
}

export interface ProjectWorkspaceProjection {
  repoRoot: string;
  workingDirectory: string;
  workspaceKind: 'repository' | 'folder' | 'multi-root' | 'cloud';
  branch?: string;
  squadAgentPath: string;
  mcpConfigPath?: string;
  supportFiles: string[];
}

export interface HostProjection {
  describe(): Promise<{
    hostKind:
      | 'github-copilot'
      | 'claude-code'
      | 'kiro'
      | 'opencode'
      | 'cursor'
      | 'codex'
      | 'antigravity';
    projectedFiles: string[];
  }>;
  projectWorkspace(): Promise<ProjectWorkspaceProjection>;
  removeProjection(input?: { rollback: 'byte-preserving' | 'managed-only' }): Promise<void>;
}

export interface AdapterSubmission {
  conversationId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterSubscription {
  conversationId: string;
  cursor?: string;
}

export interface ApprovalResponse {
  approvalId: string;
  requestHash: string;
  decision: 'approved' | 'rejected' | 'cancelled';
  responseText?: string;
}

export interface ClientAdapter {
  submit(input: AdapterSubmission): Promise<{ admissionId: string; runId: string }>;
  subscribe(
    input: AdapterSubscription,
    onEvent: (event: Record<string, unknown>) => void | Promise<void>,
  ): Promise<() => Promise<void>>;
  cancel(conversationId: string, runId: string, reason?: string): Promise<void>;
  respondApproval(conversationId: string, response: ApprovalResponse): Promise<void>;
  getCapabilities(conversationId?: string): Promise<AdapterCapabilityProjection>;
  describe(): Promise<AdapterDescription>;
  projectWorkspace(): Promise<ProjectWorkspaceProjection>;
}
```

The `HarnessAdapter` SPI is defined in
`packages/squad-sdk/src/backend/types.ts` and exported from
`@bradygaster/squad-sdk/backend`; the broker (`LocalSquadBackend`) calls it
through a `HarnessRegistry`. Copied from the source of truth:

```ts
export interface HarnessCapabilities {
  streaming: boolean;
  approvals: boolean;
  cancellation: boolean;
  tools: boolean;
  /** Extension namespaces this harness understands, e.g. `x-copilot`. */
  extensionNamespaces: string[];
}

export interface HarnessSubmission {
  conversationId: string;
  runId: string;
  seq: number;
  messages: BackendMessage[];
  extensions?: ExtensionBag;
  /** Lease epoch of the admission; echo it on every event for the run. */
  epoch?: LeaseEpoch;
}

export type HarnessEvent =
  | { type: 'message'; message: BackendMessage }
  | { type: 'task'; id: string; state: TaskState; title?: string }
  | { type: 'approval-requested'; request: HarnessApprovalRequest } // approvalId, turnSeq, action, hash, payload?, scope?
  | { type: 'state'; state: RunState; error?: string };

/** Output whose epoch is older than the conversation's is fenced off. */
export type HarnessEventEnvelope = HarnessEvent & { runId: string; seq: number; epoch?: LeaseEpoch };

export interface HarnessDescriptor {
  id: string;
  displayName?: string;
  version?: string;
  capabilities: HarnessCapabilities;
}

export interface HarnessAdapter {
  readonly id: string;                     // ^[a-z][a-z0-9-]*$
  readonly capabilities: HarnessCapabilities;
  submit(submission: HarnessSubmission): Promise<void>;
  subscribe(conversationId: string, listener: (event: HarnessEventEnvelope) => void): () => void;
  /** Idempotent: deliveries are retried. operationId is stable across retries and restarts of one delivery. */
  cancel(conversationId: string, runId: string, seq: number, operationId?: string): Promise<void>;
  /** Idempotent: deliveries are retried. operationId is stable across retries and restarts of one delivery. */
  respondApproval(conversationId: string, response: ApprovalResponse, operationId?: string): Promise<void>;
  describe(): HarnessDescriptor;
}

export interface HarnessRegistry {
  register(adapter: HarnessAdapter): void;
  get(id: string): HarnessAdapter | undefined;
  list(): HarnessDescriptor[];
}
```

The two SPIs are deliberately different in shape. `ClientAdapter` is an
asynchronous facade over a host; `HarnessAdapter` is a synchronous-subscription
SPI driven by the broker: `submit` returns nothing because the admission
(`runId`, `seq`, state, cursor) was already issued by the broker, `cancel` and
`respondApproval` are redelivered with a stable `operationId` until the
harness acknowledges them, and `describe()` is synchronous because the
registry lists harnesses during capability negotiation.

`ApprovalResponse` for a harness is the backend type (`approvalId`, `hash`,
`decision: 'approve' | 'deny'`, `reason?`, `epoch?`); the `hash` is the opaque
string the harness itself supplied with its `approval-requested` event.

No `HarnessAdapter` implementation ships in the SDK or CLI today. The
registry, the SPI and the broker-side delivery guarantees exist and are tested
with in-memory harnesses; the `squad state-mcp` bridge runs without any
harness and refuses `squad_backend_send_message` accordingly.

`describe` and `projectWorkspace` on `ClientAdapter`
let the broker reason about host capabilities and file projection without
special-casing each client in coordinator logic.

`ClientAdapter` is a composition facade: it combines a pure `HostProjection`
for `describe`, `projectWorkspace`, and `removeProjection` with runtime
bindings to `HarnessAdapter` and `SquadBackend`.

Adapters translate host-native events and commands into canonical envelopes.
They do not redefine turn ordering, causation, correlation, cancellation,
artifact semantics, resumability, or canonical error classes.

Projection is loss-tolerant. Unknown event kinds are preserved and forwarded as
opaque canonical envelopes rather than crashing the adapter. Disposable
telemetry remains separate from durable conversation events.

## 4. Host projection contract

Every host projection publishes the same minimum facts:

- the authoritative Squad agent file path for that host;
- the authoritative MCP configuration path for that host, if the host supports
  MCP;
- the companion files the host requires and whether Squad owns them fully or
  only through marker blocks;
- the host execution primitive used for `submit`;
- the workspace root and working directory used for `projectWorkspace`;
- whether approvals and background work are supported directly or must be
  broker-mediated.

If a host requires more than one file, the agent file remains the anchor and
all companion files are listed under `supportFiles`.

Capability reporting is descriptive. A host may advertise that it can render
approvals or run background work, but the policy for whether a run may do so
still lives in the shared contract and broker state.

Workspace projection config is also descriptive only. Persisted `clients[]`
entries in `.squad/config.json` are for workspace projection and host wiring,
not for authority. They exclude credentials, provider thread ids, machine
paths, leases, checkpoints, and any other mutable runtime state.

Canonical capability tokens are authoritative. The current baseline tokens are
`approvals`, `background-runs`, `cancel-run`, `cursor-reconnect`,
`mcp-bridge`, `subagents`, and `typed-content-parts`. Any boolean
`ClientCapabilities` flags are derived views only. If an adapter receives both
token lists and boolean flags as conflicting inputs, the projection rejects the
configuration instead of guessing. Advertised adapter capabilities remain
distinct from negotiated `effectiveCapabilities`.

## 5. Canonical file paths and execution primitives

| Host (`ClientId` / `hostKind`) | Agent anchor | MCP config | Support files | `submit` projection |
|---|---|---|---|---|
| GitHub Copilot (`copilot` / `github-copilot`) | `.github/agents/squad.agent.md` | `.mcp.json` | `.github/copilot-instructions.md` when present | `create_session`, `task`, or `runSubagent` depending on surface |
| Claude Code (`claude` / `claude-code`) | `.claude/agents/squad.md` | `.mcp.json` | `CLAUDE.md` marker block, `.gitignore` `# squad:claude` lines, `.claude/agents/<member>.md`, `.claude/skills/<name>/SKILL.md`, opt-in `.claude/settings.json` hooks | Claude `Agent` subagent tool |
| Kiro (`kiro`) | `.kiro/steering/squad.md` | `.kiro/settings/mcp.json` | `.kiro/agents/squad.json`, Kiro spec and steering hooks | Kiro agent or spec execution hook |
| OpenCode (`opencode`) | `.opencode/agent/squad.md` | `opencode.json` | host agent and MCP definition blocks in `opencode.json` | OpenCode agent execution entry declared in `opencode.json` |
| Cursor (`cursor`) | `.cursor/agents/squad.md` | `.cursor/mcp.json` | `.cursor/rules/squad.mdc` | Cursor agent dispatch or inline agent run with projected rules |
| Codex (`codex`) | `.codex/agents/squad.toml` | `.codex/config.toml` | `AGENTS.md` discovery pointer marker block | Codex agent execution surface |
| Antigravity (`antigravity`) | `.agents/agents/squad.md` | `mcpServers:` frontmatter in `.agents/agents/squad.md` | `GEMINI.md` marker block | Antigravity agent execution surface |

These file paths are the portable contract. A host-specific installer may
write additional generated files, but it may not move the canonical anchor
without changing the projection version.

Projection versions are per host. The Claude Code projection is at **v2**
(`CLAUDE_PROJECTION_VERSION`): v1 wrote the coordinator, `.mcp.json`, the
`CLAUDE.md` block and the `.gitignore` lines; v2 adds one subagent per member,
the template and coordinator skills, and the opt-in `settings.json` hooks.
Every generated Claude Markdown file states its version in the generated-file
note (`… Claude projection v2.`). The note keeps the v1 wording as a prefix, so
`squad upgrade` still recognizes v1 files as Squad-owned and replaces them in
place. `settings.json` handlers are identified by their `hook claude <Event>`
args instead, because JSON has no comments.

The `submit` column describes the host execution primitive only. It is not the
portable conversation wire contract. MCP-backed projections are still host
transport details behind the shared backend semantics.

The capability view exposed by an adapter mirrors the backend intersection
model. `clientCapabilities` come from the adapter, `backendCapabilities` come
from the shared service, `policyCapabilities` come from authorization policy,
and `effectiveCapabilities` are the only capabilities a projected client can
actually exercise.

Projection updates follow exact ownership rules:

- fully Squad-owned generated files are upgraded in place and removed by
  `removeProjection`;
- marker-block integrations preserve non-Squad bytes outside the managed
  region and use byte-preserving rollback when projection is removed;
- merge and upgrade routines operate only on the host's declared companion
  files and keep unrelated host configuration untouched.

## 6. GitHub Copilot projection

GitHub Copilot is treated as one host family with three common surfaces:
CLI, Copilot App, and editor-hosted subagents.

### 6.1 Canonical files

- agent anchor: `.github/agents/squad.agent.md`
- MCP config: `.mcp.json`
- support files: `.github/copilot-instructions.md`, host-specific generated
  artifacts under `.github/` when present

### 6.2 `submit`

`submit` selects one execution primitive based on the live surface:

- Copilot App prefers `create_session` for commit-producing or long-lived work;
- Copilot CLI prefers `task` for background fan-out and read-only specialists;
- editor-hosted Copilot surfaces may project `runSubagent` when available.

The adapter returns one portable run identity regardless of which primitive was
selected.

That portable run identity is `runId`, not turn sequence. Host completion or
UI status remains projection evidence and does not replace broker lifecycle
state.

### 6.3 `projectWorkspace`

The adapter reports the repository root, the active working directory, the
branch when known, `.github/agents/squad.agent.md` as the agent anchor, and
`.mcp.json` as the MCP config path. If the host requires an explicit
`--additional-mcp-config @.mcp.json` workaround, that remains an execution
detail inside the harness adapter rather than a different workspace contract.

## 7. Claude Code projection

### 7.1 Canonical files

- agent anchor: `.claude/agents/squad.md`
- MCP config: `.mcp.json`
- support files: `CLAUDE.md`, one member subagent `.claude/agents/<id>.md`
  per charter in `.squad/agents/<id>/charter.md` (built-ins included), and
  skills in `.claude/skills/<name>/SKILL.md`

The skills are Squad's template skills (from `.squad/templates/skills/`,
except where a team skill of the same name exists in `.squad/skills/`, which
keeps its precedence) and the coordinator's on-demand `squad-coordinator-*`
skills. The Claude coordinator digest replaces core-protocol items 0 (Init
Mode and casting), 9 (Ralph mode), 15 (Ceremonies), 18 (GitHub Issues mode)
and 19 (PRD mode) with stubs that keep each trigger and the rules that must
hold before the skill is loaded; the full item text moves verbatim into the
matching skill. The shared digest for other hosts and
`.github/agents/squad.agent.md` are unchanged. Skill files remain untrusted
data (core-protocol item 17).

Member subagents map charter fields onto Claude Code frontmatter:

| Charter field | Frontmatter |
|---|---|
| `Identity: ID` (or the charter directory name) | `name` |
| `Identity: Purpose` (or name and role), plus the member's `routing.md` work types | `description` |
| `Model: Preferred` | `model`, only for a Claude model or alias; omitted for `auto` |
| `Model: Reasoning Effort` | `effort`; omitted for `auto` |
| `X-squad-host-claude: Tools` | `tools` |
| `X-squad-host-claude: Isolation` (`worktree`) | `isolation` |

`X-squad-host-claude` is a charter extension (charter v0.1 §8: namespace
`squad`, name `host-claude`). Its values are runtime configuration, not
authorization (charter v0.1 §13.1). A preference the projection cannot apply
(a non-Claude model, an invalid extension value, or `long_context` without a
long-context Claude model) is recorded in a comment in the generated file
rather than dropped silently (execution preferences v0.1 §6).

Governance hooks are opt-in. With `"claudeHooks": "advisory"` in
`.squad/config.json`, the projection adds one Squad handler per event to
`.claude/settings.json`. Each handler is an exec-form command (no shell) that
runs the MCP launch spec with `hook claude <Event>` in place of `state-mcp`.
The handlers are:

| Event | Matcher | Effect |
|---|---|---|
| `SessionStart`, `SubagentStart` | `squad` (SubagentStart only) | For the coordinator only: adds context with the CLI version the `squad_state` bridge must match, the roster, routing, active reviewer lockouts and an open Ralph circuit breaker |
| `PreToolUse` | `Edit\|MultiEdit\|Write\|NotebookEdit` | A member listed in an active lockout that edits a path the subject covers gets a warning, shown to the user and to the model |
| `PostToolUse` | `Agent\|Task` | After the coordinator spawns a member: adds a `squad-coordination-handoff/v0.1` envelope with structured fields only (`result` when the call finished; `acknowledgement` for a background launch, `status: "async_launched"`, which has not finished), a reminder to record decisions and run the reviewer gate, and the member's lockout state |
| `Stop` | none | For the coordinator, once per stop (`stop_hook_active` is honoured): asks for Scribe when `decisions/inbox/` has entries, and reports an open Ralph circuit breaker |

The hooks are advisory: no handler returns a `permissionDecision` or blocks a
stop, so they never grant or deny a tool call (governance-review v0.1 §10).
A handler that fails or finds hooks turned off prints nothing and exits 0.
The decisions inbox is read from disk, so a team on a non-local state backend
gets no Scribe reminder from `Stop`.

Reviewer lockouts are recorded durably in
`<squadDir>/governance/lockouts.json` by `squad lockout reject|assign|submit|approve|override|status`.
That command implements the governance-review v0.1 §6 states (`author-locked`,
`revision-assigned`, `revision-submitted`, `cleared`, `deadlocked`). An
override needs an authority (the user, or a member listed in
`governance.authorities` in `config.json`) and a reason. Revision authors are
the members with a charter, except the coordinator, Scribe, Ralph, Rai and
Fact Checker, whose charters exclude revision pairing. Each command reads,
transitions and writes the record under an interprocess lock, so concurrent
commands keep every transition. A `governance/` directory or file that resolves
outside the team directory is refused.

Projected Claude files never copy content from outside the team directory: a
charter, `routing.md` or template `SKILL.md` that resolves outside it through a
symlink is skipped.

### 7.2 `submit`

`submit` maps to Claude Code's `Agent` subagent tool (named `Task` in earlier
Claude Code releases). Each call takes a `prompt` and a `subagent_type`, and
optionally:

- `model`: a per-call model override; subagent definitions in
  `.claude/agents/` can also set `model` and `effort` in their frontmatter;
- `run_in_background`: run the subagent without blocking the caller;
- `isolation: "worktree"`: run the subagent in its own git worktree under
  `.claude/worktrees/` (which is why the projection ignores that directory).

The harness adapter is responsible for shaping the portable prompt, handling
streaming callbacks, and projecting Claude's subagent identity into the broker
run identity.

### 7.3 `projectWorkspace`

The adapter reports the repository root, current working directory, and the
pair `.claude/agents/squad.md` plus `CLAUDE.md`, with the member subagents
under `supportFiles`, so the broker can verify that the projected host files
are in sync with the portable Squad contract.

## 8. Kiro projection

### 8.1 Canonical files

- agent anchor: `.kiro/steering/squad.md` (`inclusion: manual`)
- MCP config: `.kiro/settings/mcp.json`
- support files: `.kiro/agents/squad.json` plus any Kiro spec hook
  definitions that import the Squad steering file

`.kiro/agents/squad.json` carries workspace-root `file://.squad/team.md`
resource URIs while its `prompt` path remains relative to `.kiro/agents/`.
That split is part of the canonical projection and must survive upgrade and
rollback unchanged.

### 8.2 `submit`

`submit` maps to the Kiro execution surface that can launch an agent or spec
hook with the projected Squad steering context. The portable adapter contract
does not require Kiro to expose the same tool names as Copilot.

### 8.3 `projectWorkspace`

The workspace projection always returns `.kiro/steering/squad.md` as the
authoritative Squad steering file, `.kiro/agents/squad.json` as the agent
descriptor, and `.kiro/settings/mcp.json` as the MCP config anchor for state
and broker tools.

## 9. OpenCode projection

### 9.1 Canonical files

- agent anchor: `.opencode/agent/squad.md`
- MCP config: `opencode.json`
- support files: any agent and server definition sections nested in
  `opencode.json`

### 9.2 `submit`

`submit` maps to the agent execution entry declared by the OpenCode host.
Because OpenCode centralizes both agent and MCP definitions in `opencode.json`,
the harness adapter treats that file as the durable projection source even when
generated helpers exist elsewhere.

### 9.3 `projectWorkspace`

The adapter reports `.opencode/agent/squad.md` as the stable prompt anchor and
`opencode.json` as the host manifest that binds MCP servers and agent
definitions together.

## 10. Cursor projection

### 10.1 Canonical files

- agent anchor: `.cursor/agents/squad.md`
- MCP config: `.cursor/mcp.json`
- support files: `.cursor/rules/squad.mdc` (`alwaysApply: false`)

### 10.2 `submit`

`submit` maps to Cursor's agent dispatch surface when available. If the host
only exposes inline execution, the harness adapter still uses the same
submission payload but records `backgroundRuns: false` in `describe`.

### 10.3 `projectWorkspace`

`projectWorkspace` returns both `.cursor/agents/squad.md` and
`.cursor/rules/squad.mdc`. The rule file is part of the portable projection
because it carries the host-specific behavioral glue that accompanies the agent
prompt.

## 11. Codex projection

### 11.1 Canonical files

- agent anchor: `.codex/agents/squad.toml` (Codex custom agent: `name`,
  `description`, multi-line `developer_instructions`)
- MCP config: `.codex/config.toml`
- support files: `AGENTS.md` discovery pointer marker block

Codex is currently a compatibility-tier projection. Full coordinator instructions
live in `.codex/agents/squad.toml`, while root `AGENTS.md` carries only a short
discovery pointer inside a Squad-owned marker block so other hosts that
auto-load `AGENTS.md` are not flooded with coordinator instructions.

### 11.2 `projectWorkspace`

The projection reports `.codex/agents/squad.toml` as the agent anchor, the
`[mcp_servers.squad_state]` table inside `.codex/config.toml` as the MCP
anchor, and `AGENTS.md` under `supportFiles`.

### 11.3 Rollback

`removeProjection` deletes `.codex/agents/squad.toml`, removes the managed marker
block in `AGENTS.md`, and removes the Squad-owned TOML table in
`.codex/config.toml`, preserving all surrounding bytes verbatim.

## 12. Antigravity projection

### 12.1 Canonical files

- agent anchor: `.agents/agents/squad.md` (including `mcpServers:` frontmatter for `squad_state`)
- MCP config: inline `mcpServers:` frontmatter in `.agents/agents/squad.md`
- support files: `GEMINI.md` managed marker block

Antigravity is currently an experimental-tier projection. Its agent file wires
`squad_state` through YAML frontmatter (`mcpServers:`), and its companion
`GEMINI.md` integration is marker-scoped rather than full-file ownership.

### 12.2 `projectWorkspace`

The projection reports `.agents/agents/squad.md` as the prompt and MCP anchor
and the `GEMINI.md` marker block as the companion integration surface.

### 12.3 Rollback

Rollback removes `.agents/agents/squad.md` and removes only Squad-managed bytes
from `GEMINI.md`, restoring the preexisting file verbatim outside the marker
block.

## 13. Upgrade and rollback rules

Companion-file ownership is explicit:

- `.kiro/steering/squad.md`, `.kiro/agents/squad.json`, and
  `.kiro/settings/mcp.json` are fully Squad-managed once projected;
- `.claude/worktrees/` integration adds Squad-owned `.gitignore` lines under
  an ID-scoped `# squad:claude` comment; rollback removes that comment and the
  listed lines directly beneath it, and lines the user already had stay;
- `.claude/agents/<id>.md` member subagents and `.claude/skills/<name>/SKILL.md`
  skills are Squad-managed only while they
  carry the generated-file comment: a user-authored file at the same path is
  never overwritten or removed (the apply result is `skipped`). Upgrade
  removes the generated file of a member whose charter is gone (or of a skill
  that is no longer projected), and rollback removes every generated file;
- `.claude/settings.json` is user-owned. Squad owns only its hook handlers,
  identified by args ending in `hook claude <Event>`. Upgrade replaces those
  handlers and keeps every other setting and hook. Turning `claudeHooks` off
  removes them on the next upgrade. Rollback removes them and restores the
  remaining JSON, and deletes the file only when nothing else was in it.
  With hooks off and no settings file, nothing is written;
- the `CLAUDE.md` integration is a marker block between
  `<!-- squad:begin (managed by Squad; do not edit between markers) -->` and
  `<!-- squad:end -->`;
- `AGENTS.md` and `GEMINI.md` integrations are marker-scoped and therefore use
  byte-preserving rollback outside those managed regions. A block is appended after one blank line, and keeps
  the file's missing final newline missing, so removing it restores the
  original bytes however the file ended.

Merge and upgrade behavior follows the same rule: full ownership allows
replacement with the current projection version, while marker-scoped ownership
updates only the managed block and keeps surrounding bytes untouched.

## 14. SDK file layout

The reference SDK should keep the portable adapter contracts in a host-neutral
module and keep host projections in one sibling folder per host family.

| Concern | Canonical TypeScript path |
|---|---|
| backend conversation contracts (experimental) | `packages/squad-sdk/src/backend/` (`@bradygaster/squad-sdk/backend`) |
| client and harness adapter SPI | `packages/squad-sdk/src/client/adapter-contract.ts` |
| host projection implementations | `packages/squad-sdk/src/client/adapters/` |
| public client exports | `packages/squad-sdk/src/client/index.ts` (`@bradygaster/squad-sdk/client`) |
| deprecated alias | `@bradygaster/squad-sdk/clients` via `src/clients/index.ts` |

This profile fixes the contract locations so backend work, client work, and
contract validation can proceed in parallel without rediscovering file layout.

Those files also enforce the architectural boundary:

- `backend-contract.ts` owns conversation, participant, turn, task, artifact,
  lease, cancellation, resumability, observability, and canonical error
  semantics;
- `adapter-contract.ts` owns `HostProjection`, `ClientAdapter`,
  `HarnessAdapter`, host capability description, workspace projection, and
  translation hooks only;
- `src/clients/index.ts` remains a deprecated re-export alias and must not
  become the canonical contract location again.

## 15. Promotion criteria

Promote this draft only after the suite has:

1. contract tests that run the same `ClientAdapter` and `HarnessAdapter`
   assertions against at least GitHub Copilot plus one non-Copilot host;
2. fixtures that verify the canonical file-path projection for all seven host
   families;
3. approval and cancellation traces that demonstrate host-specific UI behavior
   still round-trips through the same portable response envelope;
4. MCP projection tests that prove `.mcp.json`, `.kiro/settings/mcp.json`,
   `opencode.json`, `.cursor/mcp.json`, `.codex/config.toml`, and
   Antigravity's `mcpServers:` frontmatter in `.agents/agents/squad.md` are
   emitted with stable semantics;
5. broker-to-harness replay tests showing that the chosen host primitive
   preserves run identity, transcript ordering, and background capability
   reporting;
6. golden-trace validation proving that adapters survive disconnect and
   reconnect without losing unknown events, durable approval versions, or
   stable `runId` cancellation targeting;
7. rollback tests proving that marker-scoped integrations restore surrounding
   bytes unchanged.
