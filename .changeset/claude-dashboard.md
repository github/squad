---
"@bradygaster/squad-cli": minor
---

New `squad dashboard` (and `/squad:dashboard` in the Claude Code plugin): a live local page of the coordinator and each member at work, read from the Claude Code session transcripts for the directory (or `--stream` stream-json logs). It listens on 127.0.0.1 only, rejects other Host headers, sends a CSP with no inline script, and runs one instance per directory (`stop`, `status`, `--detach`, `--open`, `--session`, `--port`). No dependencies beyond Node.js.
