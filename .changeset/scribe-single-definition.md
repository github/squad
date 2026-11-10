---
"@bradygaster/squad-cli": patch
"@bradygaster/squad-sdk": patch
---

Give Scribe one definition. Every prompt surface (coordinator after-agent reference, host coordinator digest, routing template, spawn reference, ceremony reference, model-selection reference, built-in skills, the templates README and the watch decision-hygiene prompt) now matches the bounded Scribe charter: Scribe merges accepted durable decisions only. Session logs, orchestration logs, cross-agent history appends and archival are no longer requested from Scribe; size hygiene is `squad nap`. The charter itself no longer lists a session log or a retrospective among the artifacts Scribe creates. The secret-handling, worktree, gh-auth-isolation and e2e-testing references no longer have Scribe commit `.squad/` changes (pre-commit secret validation now applies to whoever commits them), and the source-of-truth table lets the retrospective facilitator write the retro log that the retro gate waits for.
