# vscode-deepseek-harness

An unofficial VS Code extension that registers [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a **chat session target** in VS Code's native agent sessions view — the same surface that hosts Claude Code and Codex — rather than shipping another webview chat panel.

Status: **M0 complete.** The extension activates and the proposed APIs it needs are proven live on a real VS Code build.

- [docs/plans/0001-vscode-chat-session-provider.md](docs/plans/0001-vscode-chat-session-provider.md) — architecture decision, API mapping, and milestones.

## Relationship to upstream

DeepSeek Harness does not accept external pull requests, so this lives outside that repository and talks to it over its existing `/api` carrier — the same HTTP + WebSocket surface its own web UI uses. No fork, no patch.

**This extension never ships a dsh.** It drives the `dsh` you already installed, against your real `$DSH_HOME`, so your profiles, settings, credentials, skills and session history are the ones you already have.

## Requirements

- VS Code **1.133.0** or later.
- Your own DeepSeek Harness install.
- Proposed APIs enabled for this extension — see below.

## Enabling the proposed APIs

This extension uses two proposed APIs, `chatSessionsProvider` and `chatParticipantAdditions`. Proposed APIs cannot be shipped through the Marketplace, so the extension is distributed as a VSIX and you opt in once:

1. Command Palette → **Preferences: Configure Runtime Arguments**.
2. Add the extension id to `enable-proposed-api`:

   ```jsonc
   {
     "enable-proposed-api": ["kalynnka.deepseek-harness-sessions"]
   }
   ```

3. Restart VS Code.

You do **not** need to be on the editor's internal allowlist. VS Code checks `product.json`'s allowlist first, and falls back to whatever `enable-proposed-api` names — so this entry is the whole grant.

**Extension development mode is not a substitute.** On stable builds the editor requires `isExtensionDevelopment && quality !== 'stable'` before it grants proposals to everything, so pressing <kbd>F5</kbd> alone gets you nothing. The bundled launch configuration passes `--enable-proposed-api` explicitly for this reason.

### Verifying the grant

`src/probe.ts` answers the question against the build you actually run, which is the only place it can be answered:

```sh
npm run build
touch .dsh-probe-request
code --user-data-dir ~/.dsh-probe-vscode \
     --extensions-dir ~/.dsh-probe-vscode-ext \
     --extensionDevelopmentPath "$PWD" \
     --enable-proposed-api kalynnka.deepseek-harness-sessions \
     --new-window
cat .dsh-probe-result.json
```

It writes the verdict, then quits the window it opened:

```json
{ "vscodeVersion": "1.133.0", "ok": true, "missing": [] }
```

Use a user-data-dir under your home directory. VS Code will not start against one under `/private/tmp` on macOS.

Re-run it after every VS Code upgrade — a finalized or withdrawn proposal shows up here as `ok: false` with the exact missing member, instead of as an empty sessions list with no error.

## Development

```sh
npm install
npm run build      # or: npm run watch
npm run typecheck
```

Then <kbd>F5</kbd> (**Run Extension**), which launches an Extension Development Host with the proposal flag already set.
