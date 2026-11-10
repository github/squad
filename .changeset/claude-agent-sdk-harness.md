---
"@bradygaster/squad-sdk": minor
"@bradygaster/squad-cli": minor
---

Experimental `claude-agent-sdk` execution harness (`ClaudeAgentSdkHarness`, `@bradygaster/squad-sdk/backend`): runs conversation turns on the Claude Agent SDK, with broker approvals through `canUseTool` (hash-bound, one at a time, a deny ends the turn) and no repository or user allow rules in play. `@anthropic-ai/claude-agent-sdk` is an optional peer dependency; `squad state-mcp --experimental-backend` registers the harness only when it is installed (`SQUAD_BACKEND_HARNESSES=none` turns it off). Installs without it are unchanged.
