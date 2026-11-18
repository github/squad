---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

The Claude Code coordinator's Init Mode step now names the casting commands itself: `squad cast` for each member (or `node .squad/squad.mjs cast`), then `squad client sync`, and says never to write under `.claude/` directly. In a live run the coordinator skipped loading the init-mode skill, hand-wrote the charters and spent turns fighting Claude Code's write protection on `.claude/agents/`, so the member subagents were never created.
