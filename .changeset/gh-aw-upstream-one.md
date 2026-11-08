---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Update the Squad agentic-workflow enlistment skill to install the canonical github/squad package with stable gh-aw 1.x, without pinning the CLI installation to an exact patch release. Preserve immutable compiler-action pins and full installation/staging verification; the package currently validates gh-aw v1.0.1 output.
