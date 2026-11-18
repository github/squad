---
"@bradygaster/squad-cli": patch
---

`squad dashboard` shows a headless `claude -p` session as finished when it ends. Without Stop hooks, those sessions write neither `turn_duration` nor `stop_hook_summary`, so the page said "Prompt 1 running" forever; the dashboard now also ends the turn at the `cost-state` record the process writes when it exits.
