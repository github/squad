---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Claude Code follow-ups from the end-to-end test:

- New `squad client sync` refreshes the configured hosts' files. Init Mode now runs it after writing `routing.md`, so Claude Code member subagent descriptions say what each member owns instead of repeating the role (#2456).
- `squad_state_health` and `squad health --json` add `resolvedTeamRoot` (the directory that contains `.squad`) and `resolvedSquadDir` (the squad directory itself). `resolvedTeamDir` keeps its value, the team root, for existing consumers (#2455).
- The Claude coordinator no longer asks Scribe for session or orchestration logs, which Scribe's charter and the Copilot coordinator retired (#2454).
