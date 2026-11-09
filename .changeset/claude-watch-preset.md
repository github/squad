---
"@bradygaster/squad-cli": minor
---

`squad watch --execute` gains a built-in Claude Code runner. `--agent-preset claude` (or `watch.agentPreset: "claude"`) runs each round as `claude -p <prompt> --agent squad --mcp-config .mcp.json --output-format stream-json --verbose`, preflights the projected coordinator and the `claude` CLI, and treats an error `result` event as a failed round. Execute mode defaults to `--permission-mode bypassPermissions`; `--claude-flags` overrides it. The default Copilot runner is unchanged.
