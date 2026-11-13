---
"@bradygaster/squad-cli": patch
---

`squad doctor` compares real paths in the `squad_state` bridge check, so a team folder reached through a symlink (macOS `/var` is `/private/var`) no longer fails it.
