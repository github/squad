---
"@bradygaster/squad-sdk": patch
"@bradygaster/squad-cli": patch
---

The repository launcher `.squad/squad.mjs` now finds a `squad` on PATH. It skipped every PATH entry because it has no `bin` directory of its own, so a repository whose only Squad CLI was a global install failed with "no Squad CLI found". A new test checks that the launcher passes arguments through unchanged, including `&`, `|`, `%VAR%`, quotes and empty strings, on Windows (through npm's `.cmd` shims, never cmd.exe) and Linux.
