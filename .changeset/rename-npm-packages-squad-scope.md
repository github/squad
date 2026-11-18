---
"@squad/cli": major
"@squad/sdk": major
---

Rename the npm packages from `@bradygaster/squad-cli` and `@bradygaster/squad-sdk` to `@squad/cli` and `@squad/sdk`. `squad upgrade --self` and the update banner detect a legacy global install and remove it before installing the new package, and MCP config entries that use the old package name are still recognized as Squad-managed. Distribution names now come from `scripts/release/distribution-identity.json`, and `scripts/rename-distribution-identity.mjs` rewrites the repository when they change.
