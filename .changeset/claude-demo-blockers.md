---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Claude Code: `squad init`/`squad upgrade` add a scoped `.claude/settings.json` allowlist for Squad's own tools (the coordinator's `squad_state` tools by name, `squad cast`, `squad client sync`, `squad lockout reject` and `status` (the steps that release a lockout still ask); launcher rules only for Squad's own launcher; rollback removes only the rules Squad recorded adding), `squad cast` refuses to write through a symlink, and it is turned off with `"claudePermissions": "off"`. The non-Copilot coordinators run the reviewer gate on every code or test change unasked, treat a known gap against the issue or a recorded decision as a REJECT, never let an author review their own work, and name the recorded decision that shapes the work.
