---
"@bradygaster/squad-cli": minor
---

`squad watch --execute` gains a built-in Claude Code runner. `--agent-preset claude` (or `watch.agentPreset: "claude"`) runs each round as `claude -p <prompt> --agent squad --output-format stream-json --verbose` with a private `squad_state`-only MCP config (never the repository's `.mcp.json`), preflights the projected coordinator and the `claude` CLI, and treats an error `result` event as a failed round, including monitor, retro and decision-hygiene runs. Execute mode defaults to `--permission-mode bypassPermissions`; `--claude-flags` overrides it. `watch.claudeFlags` in `.squad/config.json` is limited to model, permission-mode, effort and turn-limit flags. The default Copilot runner is unchanged.
