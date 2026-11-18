---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Committed files no longer contain paths from your machine (#2462). When the Squad CLI is installed, `squad init` and `squad upgrade` used to write `node /your/path/cli-entry.js state-mcp` into `.mcp.json`, the other hosts' MCP configs and every Claude Code hook in `.claude/settings.json`, so they failed on any other clone. They now write `node .squad/squad.mjs state-mcp`, a launcher Squad commits that finds a Squad CLI on each machine (`SQUAD_CLI`, the project's `node_modules`, then `squad` on PATH; `npx` only with `SQUAD_ALLOW_NPX=1`). Claude hooks reach it through `$CLAUDE_PROJECT_DIR`, and standalone bundle installs write `squad state-mcp`. Run `squad upgrade` once to fix an existing repository. `squad doctor` has a new check that flags machine-specific launch commands and a missing launcher.
