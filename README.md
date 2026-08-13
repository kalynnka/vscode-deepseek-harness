# vscode-deepseek-harness

An unofficial VS Code extension that registers [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a **chat session target** in VS Code's native agent sessions view — the same surface that hosts Claude Code and Codex — rather than shipping another webview chat panel.

Status: **M0–M5 implemented.** A VSIX builds, installs and activates with its proposed APIs granted.

- [docs/plans/0001-vscode-chat-session-provider.md](docs/plans/0001-vscode-chat-session-provider.md) — architecture decision, API mapping, and milestones.
- [docs/gaps.md](docs/gaps.md) — what the chat UI wanted, what `/api` could not give it, and what was done instead.

## What it does

| | |
|---|---|
| Sessions list | Your real dsh sessions, live: added, removed, running, and blocked-on-you |
| Transcript | Past turns rebuilt from the session log, with tool cards |
| Live turns | Prose, reasoning, and tool calls streaming as they happen |
| Questions | Answered inline in the chat, blocking exactly as dsh's `ask()` does |
| Approvals | Same, as an *Allow once* / *Reject* prompt |
| Model switch | Every provider and model your dsh advertises, read fresh per session |
| Thinking effort | The reasoning efforts of the selected model, with its own default |
| Token usage | Per turn, prompt and completion, with the cache read/write split |
| Context | Percent of the model's window on each session row |
| Control | Stop, fork from a chosen turn, new session in your workspace folder |

Nothing in that table is hardcoded. Providers, models, reasoning efforts, titles, token counts and context capacity are all read from the running harness, so a model your dsh gains tomorrow appears without an update here.

## Relationship to upstream

DeepSeek Harness does not accept external pull requests, so this lives outside that repository and talks to it over its existing `/api` carrier — the same HTTP + WebSocket surface its own web UI uses. No fork, no patch.

**This extension never ships a dsh.** It drives the `dsh` you already installed, against your real `$DSH_HOME`, so your profiles, settings, credentials, skills and session history are the ones you already have. The whole VSIX is 17 KB and contains one bundled JavaScript file.

It also never asks for your API key. Credentials stay in dsh's own credentials plane, where you already put them — they are never copied into VS Code settings.

## Requirements

- VS Code **1.133.0** or later.
- Your own DeepSeek Harness install: `dsh` on `PATH`, or a built checkout (see settings).
- Proposed APIs enabled for this extension — see below.

## Install

1. Download the VSIX from Releases, or build it: `npm install && npm run build && npx @vscode/vsce package`.
2. `code --install-extension deepseek-harness-sessions-*.vsix`
3. Enable the proposed APIs, below, and restart.

## Enabling the proposed APIs

This extension uses proposed APIs, which cannot be shipped through the Marketplace. You opt in once:

1. Command Palette → **Preferences: Configure Runtime Arguments**.
2. Add the extension id to `enable-proposed-api`:

   ```jsonc
   {
     "enable-proposed-api": ["kalynnka.deepseek-harness-sessions"]
   }
   ```

3. Restart VS Code.

You do **not** need to be on the editor's internal allowlist. VS Code checks `product.json`'s allowlist first and falls back to whatever `enable-proposed-api` names, so this entry is the whole grant.

**Extension development mode is not a substitute.** On stable builds the editor requires `isExtensionDevelopment && quality !== 'stable'` before granting proposals broadly, so pressing <kbd>F5</kbd> alone gets you nothing. The bundled launch configuration passes `--enable-proposed-api` explicitly for that reason.

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

Use a user-data-dir under your home directory; VS Code will not start against one under `/private/tmp` on macOS.

Re-run it after every VS Code upgrade — a finalized or withdrawn proposal shows up here as `ok: false` naming the exact missing member, instead of as an empty sessions list with no error.

The probe **calls** the proposed function rather than checking that it exists. That distinction is the whole test: VS Code exports proposed classes and namespace functions unconditionally and refuses only at the call, so an existence check reports success even when the proposal has been denied. Measured on 1.133.0:

| | no flag | `--enable-proposed-api <id>` |
|---|---|---|
| `--extensionDevelopmentPath` | denied | granted |
| installed VSIX | denied | granted |

## Troubleshooting

**No DeepSeek Harness entry in the Agent Sessions view.** The `chatSessions` contribution is itself proposal-gated — VS Code skips it silently when the grant is missing, with no error anywhere. Check `argv.json`, then re-run the probe above.

The view also has to be switched on at all: `"chat.viewSessions.enabled": true`, or Command Palette → **Chat: Show Sessions**. **Chat Agent Sessions: Focus Agent Sessions** jumps to it.

**"No dsh found" in the log.** `deepseekHarness.executable` and `deepseekHarness.checkoutPath` are `machine`-scoped, so VS Code reads them **only from User settings** — a value in workspace or folder settings is ignored by design, because a repository must not be able to point the extension at an arbitrary binary.

## Settings

| Setting | Default | What it is for |
|---|---|---|
| `deepseekHarness.executable` | `""` | Your `dsh`, when it is not on `PATH` |
| `deepseekHarness.checkoutPath` | `""` | A built deepseek-harness checkout, run through `node` |
| `deepseekHarness.home` | `""` | Overrides `$DSH_HOME`; empty means your real one |
| `deepseekHarness.historyPageMessages` | `10` | Past messages loaded per session — kept small on purpose, see [gaps §1](docs/gaps.md) |
| `deepseekHarness.extraArgs` | `[]` | Extra arguments for `dsh web` |

The bind host and port are deliberately not configurable. The dsh web server has no TLS and no auth, so it is always started on loopback with an ephemeral port, as a child this extension owns and kills on exit.

## Development

```sh
npm install
npm run build       # or: npm run watch
npm run typecheck
npm run smoke       # read-only: starts your dsh, reads list/history/models, writes nothing
```

`npm run smoke` needs `DSH_CHECKOUT` or `DSH_EXECUTABLE` set if `dsh` is not on your `PATH`.

Then <kbd>F5</kbd> (**Run Extension**), which launches an Extension Development Host with the proposal flag already set.
