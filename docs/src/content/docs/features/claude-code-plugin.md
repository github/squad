# Squad for Claude Code (plugin)

Squad ships as a Claude Code plugin. The plugin carries the coordinator, the `squad_state` MCP server, Squad's skills, its slash commands and its governance hooks, so a repository only needs its own team: the member subagents, the `CLAUDE.md` block and two settings.

```bash
claude plugin marketplace add github/squad
claude plugin install squad@squad --scope project
squad init --client claude --claude-plugin
claude
```

Requires Node.js 22.5 or later on PATH.

---

## Install

1. Add the Squad marketplace and install the plugin. `--scope project` records it in the repository's `.claude/settings.json`, so everyone who clones the repository is offered the same plugin; use `--scope user` to install it for yourself only.

   ```bash
   claude plugin marketplace add github/squad
   claude plugin install squad@squad --scope project
   ```

   Inside Claude Code, `/plugin marketplace add github/squad` and `/plugin install squad@squad` do the same.

2. In the repository, set Squad up for the plugin:

   ```bash
   squad init --client claude --claude-plugin
   ```

   `--claude-plugin` records `"claudePlugin": true` in `.squad/config.json`. From then on `squad init` and `squad upgrade` write only the per-repository files:

   - the member subagents in `.claude/agents/`
   - the managed block in `CLAUDE.md`
   - two keys in `.claude/settings.json`: `agent`, so a plain `claude` starts the coordinator, and `disabledMcpjsonServers`, so the project's `.mcp.json` copy of `squad_state` neither prompts nor duplicates the plugin's tools

   The coordinator agent, skills and hooks come from the plugin instead of `.claude/`. `squad upgrade --no-claude-plugin` switches back to the full projection.

3. Start Claude Code with `claude`. The coordinator is the `squad:squad` agent, and the `squad_state_*` tools are available without an approval step or `--mcp-config`, including in headless `claude -p` runs.

## What the plugin provides

| Piece | Details |
|-------|---------|
| Coordinator | The `squad:squad` agent |
| Team state | The `squad_state` MCP server |
| Skills | The coordinator's on-demand skills and Squad's template skills, as `/squad:<skill>` |
| Slash commands | `/squad:ralph`, `/squad:cast`, `/squad:ceremony`, `/squad:status`, `/squad:dashboard` |
| Hooks | Squad's advisory governance hooks; they act only when `.squad/config.json` has `"claudeHooks": "advisory"` |
| `squad` on PATH | Inside Claude Code's Bash tool. The launcher uses, in order: `SQUAD_CLI`, the project's `node_modules/@bradygaster/squad-cli`, a `squad` on PATH, or `npx` of the CLI version the plugin was built with |

Plugin updates arrive through `claude plugin update squad@squad` (or Claude Code's automatic marketplace updates); the per-repository files follow `squad upgrade` as before.

## Team dashboard

`/squad:dashboard` opens a live page showing the coordinator and each member as they work: who was dispatched, what each member is doing, which members run in the background, their tool calls, summaries and results.

```text
/squad:dashboard          # start it, or show the one already running
/squad:dashboard status
/squad:dashboard stop
```

The same dashboard runs from a terminal:

```bash
squad dashboard                 # serve in the foreground (Ctrl+C to stop)
squad dashboard --detach --open # run in the background and open the browser
squad dashboard status
squad dashboard stop
```

- **What it reads.** The Claude Code session transcripts for the current directory (`~/.claude/projects/<directory>/`, or under `CLAUDE_CONFIG_DIR`), including each member's own transcript. It follows the newest session and moves to a new session when one starts; `--session <id>` pins one. `--stream <file>` reads `claude -p --output-format stream-json` logs instead.
- **One per directory.** Starting it again shows the running one. `/squad:dashboard` inside Claude Code and `squad dashboard` in a terminal find the same instance; its state lives in `~/.squad/dashboards/` (or under `SQUAD_HOME`).
- **Local only.** It listens on `127.0.0.1` (the first free port from 4280; `--port` picks one), answers only requests addressed to `127.0.0.1` or `localhost`, and sends a Content Security Policy that allows no inline script and no other origin. Transcript text is always shown as text, never as markup.
- **Nothing extra to install.** The dashboard is part of the Squad CLI and needs only Node.js.

`/squad:dashboard` is allowed to run only `squad dashboard`, and never passes your words to the shell. Set `SQUAD_DASHBOARD_NO_OPEN=1` to keep it from opening a browser.

## See also

- [Using Squad across clients](../scenarios/using-squad-across-clients.md): the full Claude Code projection without the plugin
- [Host Feature Matrix](../reference/host-feature-matrix.md)
