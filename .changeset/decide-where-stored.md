---
"@bradygaster/squad-sdk": patch
---

`squad_decide` says where a decision went on a git-branch backend (`orphan`, `two-layer`): the path is a key on the `squad-state` branch, not a file in the working tree.
