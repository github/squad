---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

Non-Copilot coordinators wait for a human's sign-off. When `team.md` or `routing.md` says a human must sign off on work, a request to do that work is no longer taken as the sign-off: the coordinator names the rule and the human, asks whether the user is that human or has their sign-off, goes ahead only on an explicit yes, and records it in the decisions inbox. In a non-interactive run it stops at the gate.
