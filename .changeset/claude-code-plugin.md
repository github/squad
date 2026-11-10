---
"@bradygaster/squad-sdk": minor
"@bradygaster/squad-cli": minor
---

Squad ships as a Claude Code plugin (`claude plugin marketplace add github/squad`, then `claude plugin install squad@squad`). The plugin carries the coordinator, the `squad_state` MCP server (no `.mcp.json` approval or `--mcp-config`), skills, advisory hooks and the `/squad:ralph`, `/squad:cast`, `/squad:ceremony`, `/squad:status` and `/squad:dashboard` commands. `squad init --client claude --claude-plugin` (or `upgrade`) records `claudePlugin` in `.squad/config.json` and then writes only the member subagents, the `CLAUDE.md` block and the `agent` and `disabledMcpjsonServers` settings.

Preserve user settings and former project MCP ownership across plugin-mode transitions, support plugin-mode watch sessions and direct init callers, skip disabled plugin hooks before CLI startup, and safely forward launcher and mesh-sync arguments. Dashboard tails preserve split UTF-8 characters, reconnects reset replayed state, and unused servers shut down after five minutes. The launcher's `npx` fallback is opt-in (`SQUAD_ALLOW_NPX=1`); without it, a missing CLI fails with install instructions. Starting a dashboard is serialized per directory, and a transcript rewritten shorter starts the page over.
