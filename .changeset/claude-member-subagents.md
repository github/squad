---
"@bradygaster/squad-sdk": minor
"@bradygaster/squad-cli": minor
---

Claude Code: each team member, built-ins included, is projected as its own subagent in `.claude/agents/<member>.md`, generated from its charter. Model, reasoning effort and the new `X-squad-host-claude` charter extension (`Tools`, `Isolation`) map onto the subagent frontmatter, and the Claude coordinator now routes to named members and applies per-spawn model selection. Squad never overwrites a user-authored file at a member path (the result is reported as `skipped`), removes the file of a member whose charter is gone, and removes every generated member file on rollback. `squad cast` refreshes the member files when `claude` is configured. Projections for other hosts are unchanged.
