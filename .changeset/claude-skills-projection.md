---
"@bradygaster/squad-sdk": minor
---

Claude Code: Squad's template skills are projected as native skills in `.claude/skills/`, except where a team skill of the same name exists in `.squad/skills/`. The Claude coordinator now loads Init Mode, Ralph mode, ceremonies, GitHub Issues mode and PRD mode on demand from generated `squad-coordinator-*` skills instead of carrying them in its always-loaded prompt. The digest for other hosts and `.github/agents/squad.agent.md` are unchanged.
