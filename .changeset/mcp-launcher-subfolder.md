---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

`squad_state` starts when Claude Code is started in a subfolder of the repository, such as a package in a monorepo. Claude Code finds the root `.mcp.json` from there but starts the server in the subfolder, so `node .squad/squad.mjs state-mcp` failed with "Cannot find module". The committed command now runs a short `node -e` script that finds the repository root (the nearest folder with `.git`) and runs only the `.squad/squad.mjs` there, so a launcher in a package's own `.squad/` or above the repository is never run.
