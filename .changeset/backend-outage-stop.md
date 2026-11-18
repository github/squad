---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

When `squad_state` is unavailable and `.squad/config.json` sets a non-local `stateBackend`, the non-Copilot coordinators stop and say so instead of writing state files in the working tree directly.
