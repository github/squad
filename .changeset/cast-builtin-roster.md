---
'@bradygaster/squad-cli': patch
'@bradygaster/squad-sdk': patch
---

`squad cast` now adds the built-in support agents (Scribe, Ralph, Rai, Fact Checker) to `team.md` when the roster doesn't list them yet, so Claude Code and Copilot report the same team after a cast. Coordinators also describe themselves separately in roster answers instead of listing "Squad" as a member (#2522).
