---
"@bradygaster/squad-cli": patch
---

`squad init` now tells you to run the host you chose (#2453). `squad init --client claude` ends with `claude --agent squad --mcp-config .mcp.json` and a matching `claude -p` tip, instead of telling Claude Code users to run Copilot. With several hosts, it gives one line per host.
