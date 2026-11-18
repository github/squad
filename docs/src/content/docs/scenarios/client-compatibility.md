# Copilot Client Compatibility Matrix

> **Quick answer:** Not sure which interface to use? See [Choose your interface](../get-started/choose-your-interface.md) for a concise decision tree and comparison.

> **New in Squad 2.0:** `squad init --client copilot|claude|kiro|opencode|cursor|codex|antigravity|all` and `squad upgrade --client ...` now project host-native adapters across all 7 supported hosts (GitHub Copilot, Claude Code, Kiro, OpenCode, Cursor, OpenAI Codex, and Google Antigravity) while keeping the backend contract portable. Start with [Using Squad across clients](./using-squad-across-clients.md) for the hands-on walkthrough and [Squad 2.0 architecture](../concepts/squad-2-0-architecture.md) for the three-plane model, MCP-vs-HTTP transport story, and the `G1`-`G9` conformance gates.

Squad runs on multiple Copilot surfaces — each with its own agent spawning mechanism, tool set, and constraints. This document maps Squad's core capabilities across CLI, VS Code, JetBrains, and GitHub.com to help you understand what works where. The Quick Reference table covers Copilot surfaces only; [Claude Code](#claude-code) has its own section below, and the [Host Feature Matrix](../reference/host-feature-matrix.md) covers every supported host feature by feature.

## Quick Reference

| Feature | CLI | VS Code | JetBrains | GitHub.com |
|---------|-----|---------|-----------|-----------|
| **Sub-agent spawning** | ✅ `task` tool | ✅ `runSubagent` / `agent` | ⚠️ Limited | ❌ Not available |
| **Agent type selection** | ✅ Full (`general-purpose`, `explore`, `task`, `code-review`) | ✅ Custom agents | ⚠️ Limited | ❌ Not available |
| **Per-spawn model selection** | ✅ Dynamic (4-layer hierarchy) | ⚠️ Static (custom agent frontmatter) | ? | ? |
| **Background/async execution** | ✅ `mode: "background"` (fire-and-forget) | ⚠️ Sync only (parallel concurrent) | ? | ? |
| **Parallel fan-out** | ✅ Background tasks + `read_agent` | ✅ Multiple subagents in one turn | ? | ? |
| **File discovery (.github/agents/)** | ✅ Automatic | ✅ Automatic | ? | ? |
| **`.ai-team/` file access (read)** | ✅ Full | ✅ Full (workspace-scoped) | ? | ? |
| **`.ai-team/` file access (write)** | ✅ Full | ✅ Full (with approval prompt) | ? | ? |
| **SQL tool** | ✅ Available | ❌ Not available | ❌ Not available | ❌ Not available |
| **MCP server access** | ✅ Full | ✅ Full (inherited) | ⚠️ Limited | ⚠️ Limited |

**Legend:**
- ✅ **Works** — Feature is fully supported with no degradation
- ⚠️ **Limited** — Feature works with constraints, degraded experience, or special configuration
- ❌ **Not available** — Feature cannot be used on this surface
- ? **Untested** — Not yet validated in production

---

## CLI (Copilot CLI)

Squad's **primary platform**. All features are fully supported.

### Agent Spawning

- **Tool:** `task`
- **Parameters:** `agent_type`, `mode`, `model`, `description`, `prompt`
- **Agent types:**
  - `general-purpose` — Full tool access (file ops, CLI, SQL, web, GitHub MCP)
  - `explore` — Read-only tools (grep, glob, view) — optimized for speed and cost
  - `task` — CLI tools + Haiku model (rarely used by Squad)
  - `code-review` — Investigation tools (available but Squad uses its own reviewer pattern)

### Model Selection

- **Mechanism:** Per-spawn `model` parameter
- **Dynamic:** Yes — each spawn can use a different model
- **4-layer hierarchy:**
  1. User override ("use opus")
  2. Agent charter preference (`## Model` section)
  3. Task-aware auto-select (Luna for non-code work, Terra for code and prompts, Sol for visual work)
  4. Default: `gpt-5.6-luna`
- **Fallback chains:** 3 retries + platform default fallback (omit parameter)
  - Premium: `gpt-5.6-sol → claude-opus-5 → claude-opus-4.8 → claude-opus-4.7 → claude-opus-4.6 → claude-sonnet-4.6 → (omit)`
  - Standard: `gpt-5.6-terra → claude-sonnet-5 → claude-sonnet-4.6 → gpt-5.5 → gpt-5.4 → gpt-5.3-codex → claude-sonnet-4.5 → gemini-3.1-pro → (omit)`
  - Fast: `gpt-5.6-luna → claude-haiku-4.5 → gpt-5.4-mini → gpt-5-mini → (omit)`

### Background/Async Execution

- **Mechanism:** `mode: "background"`
- **Behavior:** Non-blocking spawns, fire-and-forget
- **Result collection:** `read_agent` with `wait: true/false` for polling
- **Squad's typical flow:**
  1. Spawn 3-5 agents as background tasks in one response
  2. Show launch table acknowledgment to user
  3. Poll each agent's results via `read_agent` with `wait: true, timeout: 300`
  4. Assemble and present results

### File Discovery & Access

- **Auto-discovery:** `.github/agents/squad.agent.md` is discovered automatically
- **`.ai-team/` access:** Unrestricted (full filesystem)
- **Parallel reads:** Multiple file operations in one turn supported
- **Parallel writes:** Multiple file creates/edits in one turn supported

### Special Tools

- **SQL:** ✅ Available — Squad uses `sql` for tracking todos and batch processing
- **Web fetch:** ✅ Available — `web_fetch` for live data
- **GitHub MCP:** ✅ Available — Full GitHub CLI + API access
- **PowerShell:** ✅ Available — Terminal commands for git operations, builds, tests

---

## VS Code (Copilot in VS Code)

Squad runs on VS Code with **conditional support**. Key differences from CLI:

### Agent Spawning

- **Tools:** `runSubagent` (anonymous) or `agent` (named custom agent)
- **Behavior:** Sub-agents are **always synchronous** (blocking) individually, but **multiple subagents run in parallel** when spawned in the same turn
- **Custom agents:** Auto-discovered from `.github/agents/*.agent.md` (same location as CLI)
- **Default behavior:** Subagents inherit parent model and tools

### Model Selection

- **Mechanism A (Phase 1 — MVP):** Accept session model
  - Subagents use whatever model the user selected in VS Code's model picker
  - No per-spawn control
  - Loss of cost optimization (Scribe might run on Opus instead of Haiku)

- **Mechanism B (Phase 2 — Future):** Custom agent frontmatter
  - Define `model` in `.agent.md` files: `model: "Claude Haiku 4.5 (copilot)"`
  - Supports prioritized lists: `model: ['GPT-5.6 Luna (copilot)', 'Claude Haiku 4.5 (copilot)']`
  - Static per-agent, not per-spawn dynamic
  - Requires experimental setting: `chat.customAgentInSubagent.enabled: true`

- **Recommendation for now:** Use `runSubagent` (anonymous) for all spawns. Accept session model. Model cost optimization deferred.

### Background/Async Execution

- **Mechanism:** Parallel concurrent subagents (not fire-and-forget)
- **Result collection:** Automatic — no `read_agent` polling needed
- **Synchronicity:** All subagents are sync individually, but multiple subagents in one turn run concurrently
- **Fire-and-forget (Scribe):** Not possible
  - **Workaround:** Batch Scribe as the last subagent in parallel groups. Scribe is light work (Haiku model, file ops only), so blocking is tolerable
- **Launch acknowledgment:** Skip launch tables — results arrive with response, not separately

**Key insight:** VS Code's parallelism model is functionally equivalent to CLI's background mode when multiple subagents launch in the same turn. The difference is UX: CLI shows intermediate feedback (launch table), VS Code waits and shows all results at once.

### File Discovery & Access

- **Auto-discovery:** `.github/agents/squad.agent.md` auto-discovered from workspace on load (file watchers enabled — no restart needed on changes)
- **Scope:** Workspace-scoped (cannot access outside workspace directory)
- **`.ai-team/` read:** ✅ Full access via `readFile` tool
- **`.ai-team/` write:** ✅ Full access via `createFile` / `editFiles` tools
- **First-time approval:** VS Code may prompt for file modification approval on first write (security feature)
  - **User experience:** "Always allow in this workspace" option available
  - Subsequent writes in same workspace are automatic
- **Tool inheritance:** Sub-agents inherit parent's tools by default (a net positive vs CLI)
- **Parallel operations:** Multiple `readFile` / `createFile` / `editFiles` calls in one turn supported

### Special Tools

- **SQL:** ❌ Not available — avoid SQL-dependent workflows
- **Web fetch:** ✅ Available as `fetch` tool (may require URL approval)
- **GitHub MCP:** ✅ Available if configured in workspace
- **Terminal:** ✅ Available as `runInTerminal` — works for git operations
- **Codebase search:** ✅ Available as semantic (`codebase`) + literal (`searchResults`) search

### Constraints & Caveats

- **Workspace trust:** Squad requires a trusted workspace (VS Code security setting)
- **Single-root workspaces:** Recommended; multi-root has path resolution bugs (vscode#264837, vscode#293428)
- **Silent success bug:** VS Code may report file edits as successful when no changes occurred (vscode#253561) — same bug as CLI's P0 issue (Proposal 015)

---

## JetBrains IDEs (IntelliJ IDEA, PyCharm, etc.)

**Status:** Untested. JetBrains Copilot integration exists but sub-agent spawning mechanisms are not yet documented.

### Known Constraints

- No native Copilot CLI equivalent
- Copilot plugin provides chat but sub-agent spawn capability is unclear
- File discovery and workspace integration differ from VS Code

### Questions to Answer

- Does JetBrains Copilot support agent spawning via a tool equivalent to `task` or `runSubagent`?
- Can agents access workspace files and `.ai-team/` directories?
- What model selection mechanisms exist?
- Is there a background/async mode?

---

## GitHub.com (Copilot Chat in GitHub)

**Status:** Untested. GitHub's web-based Copilot has limited agent orchestration.

### Known Constraints

- Copilot Chat on GitHub.com focuses on issue-centric workflows (not general agent spawning)
- No documented sub-agent spawning mechanism
- Context is limited to conversation scope

### Questions to Answer

- Can GitHub Copilot spawn agents for background work?
- Can agents read `.ai-team/` files from the repository?
- Is there a GitHub-specific command protocol for delegation?

---

## Claude Code

**Status:** Supported through `squad init --client claude` (or `squad upgrade --client claude`), with live lab runs. Per-feature status is in the [Host Feature Matrix](../reference/host-feature-matrix.md); work to make Claude Code a first-class host is tracked in [#2438](https://github.com/github/squad/issues/2438).

### What Squad projects

- `.claude/agents/squad.md` — the coordinator, as a Claude Code subagent named `squad`
- `.claude/agents/<member>.md` — one subagent per team member, built-ins included, generated from `.squad/agents/<member>/charter.md`. `squad cast` adds the new member's file. If you already have your own file at one of these paths, Squad leaves it alone and reports it as skipped.
- `.claude/skills/<name>/SKILL.md` — Squad's skills as native Claude Code skills, plus `squad-coordinator-*` skills the coordinator loads on demand (Init Mode, Ralph, ceremonies, GitHub Issues and PRD modes), which keeps its always-loaded prompt smaller. A team skill of the same name in `.squad/skills/` takes precedence, so that template isn't projected. Your own skills in `.claude/skills/` are left alone.
- `.mcp.json` — the `squad_state` MCP server, merged without touching your other servers
- `CLAUDE.md` — a Squad-managed marker block
- `.gitignore` — `.claude/worktrees/` under a `# squad:claude` comment
- `.claude/settings.json` — Squad's governance hooks, only if you opt in (see below). Your other settings and hooks are kept.

`squad init --client claude` also writes the GitHub Copilot files: `.github/agents/squad.agent.md`, `.github/skills/`, `.copilot/mcp-config.json`, the Squad workflows under `.github/workflows/` and `.vscode/settings.json`. This is intended. GitHub Copilot is the base host. The Claude Code coordinator is generated from the same shared source as Copilot's `.github/agents/squad.agent.md` and is complete on its own: it doesn't read Copilot's file ([ADR-003](https://github.com/github/squad/blob/dev/docs/specification/adr-003-host-neutral-canonical-coordinator.md), option C). Skip the workflows with `--no-workflows` and the VS Code setting with `--no-vscode-default`.

### Starting a session

```bash
claude --agent squad --mcp-config .mcp.json
```

Interactive Claude Code doesn't load project-scoped `.mcp.json` servers until you approve them, so pass the config explicitly. Headless runs (`claude -p`) need `--mcp-config` too, or a prior approval for the project; without it, the coordinator stops at the state-backend handshake.

### Capabilities

| Feature | Status | Notes |
|---------|--------|-------|
| **Sub-agent spawning** | ✅ `Agent` tool | Each member runs as its own subagent (`subagent_type: "<member>"`), which reads its charter. Squad dispatches specialists only from the coordinator; members don't spawn subagents of their own. This is Squad's dispatch policy and doesn't depend on whether your Claude Code version allows nested subagents. |
| **Parallel fan-out** | ✅ | Independent `Agent` calls in one message run in parallel. |
| **Background/async execution** | ✅ `run_in_background` | Validated in live runs. |
| **Worktree isolation** | ✅ `isolation: "worktree"` | Claude Code creates worktrees under `.claude/worktrees/`, which Squad ignores in git. |
| **Per-spawn model selection** | ✅ | A member's subagent uses the Claude model in its charter's `Preferred` field, and the reasoning effort from `.squad/config.json` or the charter. The coordinator passes a per-call `model` when your request, `agentModelOverrides`, `defaultModel` or the session's model takes precedence. Re-run `squad upgrade` after changing reasoning-effort config. A non-Claude model, a one-off effort request and `long_context` without a long-context Claude model are reported rather than applied. |
| **MCP server access** | ✅ | `squad_state` tools appear as `mcp__squad_state__*`; subagents inherit them. |
| **Hooks** | ✅ Opt-in, advisory | Off by default. See [Governance hooks](#governance-hooks). |
| **`squad watch --execute`** | ✅ Preset | `squad watch --execute --agent-preset claude` (or `"agentPreset": "claude"` under `watch` in `.squad/config.json`) runs each round as `claude -p … --agent squad` with a `squad_state`-only MCP config written by the `squad` CLI (never the repository's `.mcp.json`, whose other servers keep Claude Code's approval). Execute mode defaults to `--permission-mode bypassPermissions`, the counterpart of Copilot's `--yolo`; override it with `--claude-flags`. Fleet dispatch (`--dispatch-mode fleet`) stays Copilot-only. |

### Permissions for Squad's own tools

`squad init --client claude` and `squad upgrade --client claude` add these rules to `permissions.allow` in `.claude/settings.json`, so the coordinator can cast a team and use its state without a permission prompt for each call:

- each `squad_state` tool the coordinator uses, by name: `mcp__squad_state__squad_decide`, `…__squad_state_read`, `…_write`, `…_append`, `…_delete`, `…_list`, `…_create_if_absent`, `…_health` and `…_upstreams` (in plugin mode, the same tools under `mcp__plugin_squad_squad_state__`). Not the whole server: the experimental backend tools, such as approving a harness request, and the `memory.*` tools still ask.
- `Bash(squad cast:*)`, `Bash(squad client sync:*)`, `Bash(squad lockout reject:*)` and `Bash(squad lockout status:*)`. Recording a rejection only adds a restriction. The steps that move a lockout toward release (`assign`, `submit`, `approve` and `override`) always ask, so an agent can't clear a lockout on its own.
- The same commands through the repository launcher, `node .squad/squad.mjs …`, only while `.mcp.json` runs Squad's own launcher from a folder inside the repository. A `squad.mjs` Squad didn't write is never pre-approved.

Nothing else is allowed: no edits, no other commands, no other MCP servers. `squad cast` refuses to write through a symbolic link, so a pre-approved cast can't be pointed at a file outside the team folder. Your own rules stay first and are never changed. Squad records the rules it added in `.claude/.squad-permissions.json` (commit it with `settings.json`), and removing Claude Code from the team, or turning the allowlist off, removes only those: a rule you had already written stays. Claude Code applies a project's allow rules only once you've trusted the folder (the trust prompt on your first interactive `claude` run there); until then, and in headless runs in an untrusted folder, it ignores them and says so. To turn the allowlist off, set `"claudePermissions": "off"` in `.squad/config.json` and run `squad upgrade --client claude`.

### Governance hooks

To turn the hooks on, add `"claudeHooks": "advisory"` to `.squad/config.json` and run `squad upgrade --client claude`. Squad then adds these hooks to `.claude/settings.json`:

- **Session start:** the coordinator starts with the roster, routing, active reviewer lockouts and the CLI version its `squad_state` bridge must match.
- **Before an edit:** a member who is locked out of a review subject gets a warning when it edits a file that subject covers. You see the warning too.
- **After a member finishes:** the coordinator gets a handoff summary and a reminder to record decisions and run the reviewer gate.
- **When the coordinator stops:** it's reminded to run Scribe if `.squad/decisions/inbox/` has entries, and you're told if Ralph's circuit breaker is open.

The hooks only warn. They never block a tool call or permission, and they print nothing when hooks are off. To turn them off, set `"claudeHooks": "off"` and run `squad upgrade --client claude` again. Squad removes its hooks and leaves the rest of `.claude/settings.json` as it was.

Reviewer lockouts come from `squad lockout`. For example, after Ripley rejects Dallas's work on issue 42:

```bash
squad lockout reject issue-42 --author dallas --reviewer ripley --reason "no tests for the auth path" --paths "src/auth/**"
```

```bash
squad lockout assign issue-42 --successor lambert
```

`squad lockout status` lists each subject with its state and who can take the next revision. `submit` and `approve` record the revision and its approval, which ends the lockout. `override` lets you, or a member listed in `governance.authorities` in `.squad/config.json`, let a locked-out author back in, with a reason. If no eligible member is left, the subject is marked deadlocked until someone records an override.

---

## Platform Adaptation Guide

### For Developers Using Squad

**Use CLI if:**
- You need sub-agent spawning with full control (model selection, agent type, background mode)
- You use SQL in your Squad workflows
- You need fire-and-forget execution (Scribe)
- You want cost optimization via Haiku/Sonnet/Opus tiering

**Use VS Code if:**
- You work in VS Code and want seamless integration
- You don't need per-spawn model selection (accept session model)
- You're OK with Scribe running synchronously (batched with other agents)
- You prefer not to see intermediate launch tables

**Using Both:**
- CLI is recommended for initial Squad setup and learning
- VS Code works for day-to-day development once Squad is established
- They share the same `.ai-team/` state — both can read/write the same team files
- Team state is portable — init in CLI, use in VS Code, export/import across repos

### For Squad Developers

**Coordinator Instructions:** Add platform detection logic to `squad.agent.md`:

```markdown
## Platform Detection

Before spawning agents, detect which platform you're running on:

1. **CLI mode** — `task` tool is available
   - Use `task` with `agent_type`, `mode`, `model`, `description`, `prompt` parameters
   - Full spawning control: per-spawn model selection, background mode, agent type selection
   - Use `read_agent` for result collection

2. **VS Code mode** — `runSubagent` or `agent` tool is available
   - Use `runSubagent` with task prompt (equivalent to CLI's `prompt` parameter)
   - Drop: `agent_type` (all subagents have full tools), `mode` (always sync), direct `model` param
   - Spawn multiple subagents in SINGLE turn for parallel execution
   - Results arrive automatically (skip `read_agent`)
   - Batch Scribe as last subagent in parallel groups (Scribe blocks)

3. **Fallback mode** — Neither `task` nor `runSubagent` available
   - Work inline without delegation
   - Do not apologize or explain the limitation
   - Execute the task directly to best of your ability
```

**Feature Degradation Plan:**

| Feature | CLI | VS Code | Degradation |
|---------|-----|---------|-------------|
| **Parallel fan-out** | Background + `read_agent` | Parallel sync subagents in one turn | None — equivalent concurrency |
| **Model selection** | Per-spawn dynamic | Session model (or custom agent static) | Accept session model, log intent |
| **Scribe fire-and-forget** | Background, never read | Sync, must wait | Batch with last parallel group |
| **Launch table UX** | Show table immediately → results later | Skip table → results with response | UX only, results correct |
| **SQL workflows** | Supported | Not available | Avoid SQL in cross-platform code paths |
| **Response order bug** | Critical workaround | Possibly necessary (unknown) | Keep the block — harmless if unnecessary |

---

## Investigation Status

This document is based on active research spikes (#32, #33, #34) conducted in February 2026. Key findings:

- **Proposal 032a** (Strausz): `runSubagent` API research — agent spawning mechanics on VS Code
- **Proposal 032b** (Kujan): CLI spawn parity analysis — all 5 Squad spawn patterns mapped
- **Proposal 033a** (Strausz): VS Code file discovery — `.ai-team/` access and workspace scoping
- **Proposal 034a** (Kujan): Model selection & background mode — per-agent model routing and async execution

**Next steps:**
- [ ] JetBrains investigation spike (#12)
- [ ] GitHub.com investigation spike (#13)
- [ ] VS Code custom agent generation during `squad init` (Phase 2, v0.5.0)
- [ ] Empirical testing of Response Order bug workaround on VS Code

---

## See Also

- [Squad in VS Code](../features/vscode.md) — Getting started with VS Code, what's different from CLI
- [Model Selection](../features/model-selection.md) — Cost-first routing across agents
- [Parallel Execution](../features/parallel-execution.md) — Background and sync patterns
- [Worktrees](../features/worktrees.md) — Multi-branch isolation
- [Troubleshooting](./troubleshooting.md) — Common questions and answers
