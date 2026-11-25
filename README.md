# Squad

[English](README.md) | [中文](README.zh.md)

**Human-led AI agent teams for any project.**

Squad gives you a team of specialists through GitHub Copilot and other AI clients. Describe what you're building; your team lives in your repository and carries context across sessions. You stay in charge of priorities, approvals, and final changes.

## 1. Install Squad

Install [Git](https://git-scm.com/) and your preferred AI client, then choose one Squad installation method:

| Method | Command |
|--------|---------|
| npm (all platforms, Node.js 22.5+) | `npm install -g @bradygaster/squad-cli` |
| Homebrew (macOS) | `brew install --cask bradygaster/squad/squad` |
| WinGet (Windows) | `winget install --id bradygaster.Squad --exact` |

Homebrew and WinGet include Node.js. For install scripts, direct downloads, and prerequisites, see the [installation guide](docs/src/content/docs/get-started/installation.md).

Check that the CLI is available:

```bash
squad --version
```

## 2. Open your project

Open a terminal in an existing Git repository, or create one:

```bash
mkdir my-project && cd my-project
git init
```

## 3. Initialize for your client

For GitHub Copilot (CLI or VS Code), run `squad init`. To choose a client explicitly, run one of:

| Client | Initialize in your project |
|--------|----------------------------|
| GitHub Copilot (CLI or VS Code) | `squad init --client copilot` |
| Kiro | `squad init --client kiro` |
| OpenCode | `squad init --client opencode` |
| Cursor | `squad init --client cursor` |
| OpenAI Codex | `squad init --client codex` |
| Google Antigravity | `squad init --client antigravity` |
| Claude Code | `squad init --client claude` |

Use a comma-separated list for multiple clients, or `all` for every supported client:

```bash
squad init --client copilot,cursor,codex
squad init --client all
```

These clients share one `.squad/` team. Check that `.squad/team.md` was created.

## 4. Launch your AI client

**Copilot CLI:** Sign in to Copilot, then launch Squad from your project directory:

```bash
copilot --agent squad
```

**VS Code:** Open the project, open Copilot Chat, and select the **Squad** agent.

**Other clients:** Follow the [per-client launch and MCP setup instructions](docs/src/content/docs/scenarios/using-squad-across-clients.md) for your chosen client. Each client needs its own sign-in and model access.

For GitHub issues and pull requests, also install the [GitHub CLI](https://cli.github.com/) and run `gh auth login`; verify with `gh auth status`.

## 5. Set up your team and give it work

Tell Squad what you're building:

```text
I'm starting a new project. Set up the team.
Here's what I'm building: a recipe sharing app with React and Node.
```

Review the proposed team and confirm when you're ready. Then give it a focused task:

```text
Team, add a recipe search page and tests. Ask me before expanding the scope.
```

Review the team's changes and test results before accepting them. Say **"squad commands"** in chat to discover more actions.

## Next steps

- [First session guide](docs/src/content/docs/get-started/first-session.md) — working with your team.
- [Documentation](https://github.github.com/squad/) — upgrades, features, and reference guides.
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)
