---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Projects linked to a team repository (`squad link`, `squad init --mode remote`) use that team: `squad init`/`squad upgrade` no longer scaffold a placeholder local roster, routing, charters or casting; Claude Code member subagents are projected from the linked team; and every coordinator digest reads a linked team through `squad_state`.
