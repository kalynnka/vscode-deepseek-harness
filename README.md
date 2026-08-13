# vscode-deepseek-harness

An unofficial VS Code extension that registers [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a **chat session target** in VS Code's native agent sessions view — the same surface that hosts Claude Code and Codex — rather than shipping another webview chat panel.

Status: **planning**. Nothing is implemented yet.

- [docs/plans/0001-vscode-chat-session-provider.md](docs/plans/0001-vscode-chat-session-provider.md) — architecture decision, API mapping, and milestones.

## Relationship to upstream

DeepSeek Harness does not accept external pull requests, so this lives outside that repository and talks to it over its existing `/api` carrier — the same HTTP + WebSocket surface its own web UI uses. No fork, no patch.
