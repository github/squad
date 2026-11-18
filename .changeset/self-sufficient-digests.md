---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

The coordinators for Claude Code, Kiro, OpenCode, Cursor, Codex and Antigravity are complete on their own (ADR-003 option C, #2487). They no longer call GitHub Copilot's `.github/agents/squad.agent.md` the authoritative contract or tell the model to read it, and their text no longer depends on that file: the same bytes are projected whether it is absent, stock or customized. GitHub Copilot's output is unchanged.
