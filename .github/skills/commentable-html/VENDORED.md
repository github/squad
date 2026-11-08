# Vendored skill: commentable-html

This folder is a pinned, unmodified copy of the `commentable-html` skill from the
[urikan-ai-marketplace](https://github.com/urikanonov/ai-marketplace) plugin marketplace.
The skill turns a standalone HTML plan or report into an inline-comment review surface,
and **Copy all** hands every comment back to the agent as one bundle.

| | |
|---|---|
| Source | `urikanonov/ai-marketplace`, `plugins/commentable-html/pkg/skills/commentable-html/` |
| Commit | `bc5e7a94d653e87163e885106d58011e0457ac2c` (2026-11-06) |
| Plugin version | 1.858.1 |
| License | MIT (`LICENSE`); bundled third-party components are listed in `THIRD_PARTY_NOTICES.md` |

## What's here

- `SKILL.md`, `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied unchanged.
- `dist/`, `references/`, `tools/` and `vendor/` are the contents of the plugin's `skill-resources.zip`.
  The plugin normally unpacks that archive with a session-start hook. This copy ships the files
  already unpacked and has no hook.

Don't edit these files here. Refresh them from upstream instead.

## How it relates to `.github/copilot/settings.json`

`.github/copilot/settings.json` also enables the `commentable-html@urikan-ai-marketplace`
plugin, so Copilot CLI installs it on every machine that works in this repository and the skill
is then available in other repositories too. Inside this repository, Copilot CLI lists this
project copy instead of the plugin's skill, so sessions here use the pinned version.

To opt out of the plugin, add this to an uncommitted `.github/copilot/settings.local.json`:

```json
{
  "enabledPlugins": {
    "commentable-html@urikan-ai-marketplace": false
  }
}
```

## Refresh

Run this from the repository root in bash (Git Bash on Windows). Set `sha` to the upstream
commit you want, then update the table above.

```bash
sha=bc5e7a94d653e87163e885106d58011e0457ac2c
dst=.github/skills/commentable-html
base=repos/urikanonov/ai-marketplace/contents/plugins/commentable-html/pkg/skills/commentable-html
find "$dst" -mindepth 1 ! -name VENDORED.md -delete
for f in SKILL.md LICENSE THIRD_PARTY_NOTICES.md skill-resources.zip; do
  gh api "$base/$f?ref=$sha" -H 'Accept: application/vnd.github.raw' > "$dst/$f"
done
unzip -q "$dst/skill-resources.zip" -d "$dst"
rm "$dst/skill-resources.zip"
```
