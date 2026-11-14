---
"@bradygaster/squad-sdk": patch
---

Claude Code no longer gets Copilot's template `init-mode` and `coordinator-init-mode` skills (project mode or plugin). They wait for a confirmation through a tool Claude Code lacks and write the team by hand; Claude's coordinator uses `squad-coordinator-init-mode`.
