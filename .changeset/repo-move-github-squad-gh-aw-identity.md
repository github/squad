---
'@bradygaster/squad-cli': patch
'@bradygaster/squad-sdk': patch
---

Update the shipped gh-aw-enlistment skill for the repository's new home, `github/squad`. It now installs the gh-aw package as `github/squad/workflows`, links to the docs guide's new address, and allowlists the `github/squad/.github/actions/squad-init` action. Before installing or upgrading, it checks that the chosen Squad revision declares `github/squad/workflows` in its package manifest, and stops otherwise. It also explains how to move an installation off the legacy `bradygaster/squad/workflows` identity, which the install verifier still accepts. That upgrade stops before removing anything if the forced reinstall fails, and until it is committed, its strict compile gate accepts only the four expected squad-init owner-replacement warnings.
