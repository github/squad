---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Claude Code: `squad init`/`squad upgrade` add a scoped `.claude/settings.json` allowlist for Squad's own tools (the `squad_state` server and `squad cast`, `squad client sync`, `squad lockout`), turned off with `"claudePermissions": "off"`. The non-Copilot coordinators run the reviewer gate on every code or test change unasked, treat a known gap against the issue or a recorded decision as a REJECT, never let an author review their own work, and name the recorded decision that shapes the work.
