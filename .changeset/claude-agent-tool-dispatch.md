---
"@bradygaster/squad-sdk": patch
---

The Claude Code coordinator now names Claude Code's `Agent` subagent tool (formerly `Task`) and describes its `run_in_background` and `isolation: "worktree"` options. Existing Claude Code installs see this wording change in `.claude/agents/squad.md` on the next `squad upgrade --client claude`; Copilot output is unchanged.
