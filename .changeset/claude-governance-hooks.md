---
"@bradygaster/squad-sdk": minor
"@bradygaster/squad-cli": minor
---

Claude Code: opt-in advisory governance hooks. With `"claudeHooks": "advisory"` in `.squad/config.json`, `squad upgrade --client claude` adds Squad hooks to `.claude/settings.json`, keeping your other settings and hooks. The hooks give the coordinator session context, warn a locked-out member who edits work under review, add a handoff summary after each member finishes, and remind the coordinator to run Scribe. They never block a tool call. New `squad lockout` command records reviewer lockouts in `.squad/governance/lockouts.json`, and the new `squad hook claude <Event>` command runs the hooks.
