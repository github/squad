---
"@bradygaster/squad-cli": patch
---

Preserve governed memory when migrating local/worktree storage to orphan/two-layer storage, including decision inbox records, the array index, configuration, audit archives and tombstones. Abort on destination conflicts or transfer failure before changing backend authority, and retain source files until the config write succeeds so identical imports can be retried.
