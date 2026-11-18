# Package Rename: @squad/cli and @squad/sdk

> Squad's npm packages moved from `@bradygaster/squad-cli` and `@bradygaster/squad-sdk` to `@squad/cli` and `@squad/sdk`. The commands, the `squad` binary, and your `.squad/` team state are unchanged.

| Before | Now |
|--------|-----|
| `@bradygaster/squad-cli` | `@squad/cli` |
| `@bradygaster/squad-sdk` | `@squad/sdk` |
| `@bradygaster/squad-sdk/<subpath>` | `@squad/sdk/<subpath>` |

Homebrew, WinGet and the standalone binaries keep their current names.

## Switch a global install

Both packages provide the `squad` command, so remove the old one first:

```bash
npm uninstall -g @bradygaster/squad-cli
npm install -g @squad/cli
```

With pnpm or yarn:

```bash
pnpm remove -g @bradygaster/squad-cli && pnpm add -g @squad/cli
yarn global remove @bradygaster/squad-cli && yarn global add @squad/cli
```

Once you're running a build that knows about the rename, `squad upgrade --self` does this for you: it detects an install made under the old name and runs the uninstall before installing `@squad/cli`. Use `squad upgrade --self --dry-run` to see the exact command first.

## Update projects and scripts

- **npx:** replace `npx @bradygaster/squad-cli …` with `npx @squad/cli …`.
- **SDK dependency:** replace `@bradygaster/squad-sdk` with `@squad/sdk` in `package.json`, and update imports such as `@bradygaster/squad-sdk/client` to `@squad/sdk/client`.
- **MCP configs:** `squad upgrade` rewrites the Squad-managed `squad_state` entry to `npx -y @squad/cli@<version> state-mcp`. Entries written by older versions under the old name are still recognized as Squad-managed, so they are refreshed or cleaned up rather than treated as user customizations.

## What happens to the old packages

The `@bradygaster/*` packages stay on npm and keep working. They'll be marked deprecated, with a message pointing here, only after `@squad/cli` and `@squad/sdk` are published and verified. Nothing is unpublished.

## For maintainers

The published identities live in `scripts/release/distribution-identity.json`. To move to a different name, set the new `current` value, add the old value to `legacy`, update the matching constants in `packages/squad-cli/src/cli/core/package-identity.ts`, and run:

```bash
node scripts/rename-distribution-identity.mjs --write
npm install
```

Run `node scripts/rename-distribution-identity.mjs` without `--write` to list any files that still reference a retired name. Changelogs, blog posts, internal launch notes, and live `.squad/` state are left unchanged on purpose.
