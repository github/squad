---
"@bradygaster/squad-sdk": minor
---

The Claude Code projection is now v2 (`CLAUDE_PROJECTION_VERSION`): member subagents, skills and the opt-in `settings.json` hooks ship as one version, and every generated Claude Markdown file states it in its generated-file note. v1 files are still recognised as Squad-owned and upgraded in place. Rollback of the `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` marker blocks now restores the original bytes exactly, including files that ended without a newline or with a blank line.
