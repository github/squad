---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

`squad_state` works when the team folder is reached through a symlink, such as macOS `/tmp` or a linked team root. A confined storage provider stored its root resolved but compared it with paths in the original spelling, so it refused them with "Path traversal blocked". Paths that really leave the folder are still refused.
