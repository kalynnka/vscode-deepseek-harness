# 0001 — DeepSeek Harness as a VS Code chat session provider

Status: proposed
Date: 2026-08-14

## 1. What we are building

An extension that makes DeepSeek Harness (`dsh`) appear as a session target in VS Code's **native agent sessions view** — the list that currently holds `CLAUDE CODE` and `CODEX` — with VS Code rendering the conversation, the tool calls, the questions, and the approvals through its own chat UI.

We are explicitly **not** building another chat webview.

## 2. Why this route

Four routes were evaluated against the requirement "usable UI, no duplicated harness".

| Route | Verdict |
|---|---|
| ACP under Copilot | **Rejected.** Two harnesses fight over the same job. Worse, dsh's ACP `session/update` emits one `agent_message_chunk` per committed `assistant/message` and drops raw deltas and every non-message event — reasoning and tool activity are documented as staying "in the session log for observability through other interfaces". Nothing to render. |
| JSON-RPC SDK server (`@deepseek-ai/dsh-sdk-jsonrpc-server`) | **Rejected.** Client→server is `initialize` / `session/prompt` / `shutdown`. Server→client requests are documented as a **dead capability** — the transport supports them, the server never sends one. No approval, no question, no cancel. |
| Webview chat panel | **Rejected.** This is what both existing third-party extensions did; it means reimplementing the whole chat UI in markdown, and it is where they stalled. |
| **`/api` carrier + `chatSessionsProvider`** | **Chosen.** dsh's own web UI's transport, and VS Code's own chat UI. Neither half is reimplemented. |

The decisive facts:

- `/api` is a full four-quadrant discriminated union — `ClientRequest` (POST `/api/<method>`), `ServerResponse` (that POST's body), `ServerRequest` (WS frame), `ClientResponse` (POST `/api/respond`). Server→client requests are **live** here; that is where questions and approvals come from.
- `AbstractApiClient` has exactly **one** abstract member, `doFetch`. Every protocol invariant — rpcId minting, envelope wrap/unwrap, zod parsing, frame decoding — is in the base class. A Node port is one method plus two WebSocket overrides.
- VS Code's proposed API has a near-exact counterpart for every interactive primitive dsh exposes (§6).

## 3. Naming

Repo name — recommendation: **keep `vscode-deepseek-harness`**.

| Candidate | Assessment |
|---|---|
| `vscode-deepseek-harness` | Matches the `vscode-<subject>` convention of Microsoft's own repos (`vscode-eslint`, `vscode-python`, `vscode-go`). Unambiguous. **Recommended.** |
| `dsh-vscode` | Shorter, uses the CLI brand. But `dsh-*` is upstream's *package* namespace (`@deepseek-ai/dsh-<pkg>`); it reads like an official package. |
| `vscode-dsh-sessions` | Names the mechanism precisely, but ages badly the moment we add a surface that is not a session. |
| `deepseek-harness-vscode` | **Taken twice.** `bingchengle/deepseek-harness-vscode` is that exact string; `skymecode/deepseek-harness-for-vscode` is one word off. |

Marketplace identity is the thing that actually collides, and it is separate from the repo name:

- `deepseek-harness-community.deepseek-harness` — taken by skymecode, who also claimed the `-community` publisher name.
- `bingchengle.dsh-vscode-chat` — taken.
- Ours: publisher = personal publisher id; extension name = `deepseek-harness-sessions`; display name = **DeepSeek Harness Sessions**.

**Trademark:** DeepSeek owns the name and the project. The description must say *unofficial* and link upstream. skymecode's `-community` publisher name is exactly the kind of thing that invites a takedown; do not imitate it.

## 4. Process and transport architecture

```
VS Code extension host
  └─ NodeApiClient extends AbstractApiClient      ← the only platform port
       ├─ doFetch            → global fetch (Node ≥22)
       ├─ openMux  (override)→ ws://…/api/events.mux
       └─ openHost (override)→ ws://…/api/events.host
  └─ ConnectionController                          ← reused verbatim from upstream
  └─ HarnessProcess                                ← spawn / port discovery / lifecycle
       └─ child: dsh web --host 127.0.0.1 --port 0
```

Reused from upstream without modification: `AbstractApiClient`, `ConnectionController`, every zod schema, the rpc-map types. Written by us: `NodeApiClient` (~60 lines), `HarnessProcess`, and the VS Code adapters.

### 4.1 Port discovery — verified

> ~~`--port 0` binds an ephemeral port. Read the actual port from the child's stdout banner; do not guess, do not scan.~~

`--port 0` binds an ephemeral port; `WebServer.Config.port` accepts `0` and `get port()` returns the OS-assigned value from `server.address()` ([webserver/src/index.ts:218-223](../../../deepseek-harness/packages/host/webserver/src/index.ts#L218-L223)).

The child prints exactly one line on **stdout** via `console.log`:

```
dsh web: http://127.0.0.1:<port>
```

`printUrl` defaults to `true` ([bundle/web-app/src/index.ts:53](../../../deepseek-harness/packages/bundle/web-app/src/index.ts#L53)). Parse that line; do not guess, do not scan.

### 4.2 Readiness — the banner *is* the readiness signal

> ~~Do not send anything before `ConnectionController`'s handshake settles. Its `loop()` awaits `host.describe({})` **and** both streams opening, in a `Promise.all`, specifically so "the resync it triggers cannot outrun the subscribed baseline". Respect that; the failure mode is a silently truncated first render.~~ — still true, but it is the *second* of two readiness gates, not the only one.

Upstream states this as a contract, not an accident. From [bundle/web-app/src/index.ts:159-183](../../../deepseek-harness/packages/bundle/web-app/src/index.ts#L159-L183):

> The URL line is a readiness signal: supervisors (and the keyless CLI smoke) RPC as soon as they observe it, so it must not print while sibling rows (the `/api` route owner) are still mounting.

The line is emitted only after `ctx.get('loader').await()` settles, and is suppressed if the tree was torn down mid-boot. So §4.1 and §4.2 are one signal: **on the banner line, `/api` is mounted and it is safe to connect.** No polling, no retry loop.

That is the transport-level ready. The protocol-level ready is still `ConnectionController`'s handshake — its `loop()` awaits `host.describe({})` **and** both streams opening in a `Promise.all`, so "the resync it triggers cannot outrun the subscribed baseline". Respect both; the failure mode of skipping the second is a silently truncated first render.

### 4.3 `$DSH_HOME` — the differentiator

The existing extension sets `DSH_HOME` to its own `globalStorageUri`, giving the user a second, empty dsh world: their profiles, `settings.yaml`, credentials, skills, and session history are all invisible inside the editor.

**Decision: default to the user's real `$DSH_HOME` (`~/.dsh`).** The extension drives the dsh the user already configured. A bundled runtime exists only as a fallback for users with no install, and switching to it is an explicit setting, not a silent default.

Consequences to handle:
- Version skew between the user's `dsh` and the `/api` shape we compiled against — detect at handshake via `host.describe`, degrade with a named error, never crash.
- API key: read from the user's existing credentials plane. **Do not** instruct users to paste `DEEPSEEK_API_KEY` into VS Code `settings.json`, which is what the existing extension does and which lands the key in synced settings.
- *(added)* **`dsh` may not be on `PATH` at all.** On this machine `~/.dsh` is fully populated — `profiles/`, `sessions/`, `.credentials.yaml`, `settings.yaml` — while `which dsh` finds nothing: the harness runs from the monorepo checkout (`apps/cli/lib/bin.js`), never installed globally. A `HarnessProcess` that spawns bare `dsh` fails for exactly the users most likely to try this first. Resolve the executable in order: an explicit setting → `PATH` → a configured checkout's `apps/cli/lib/bin.js` under `node` → the bundled fallback. Report which one was chosen; a silent fallback to the wrong dsh is the §4.3 failure this whole section exists to prevent.

### 4.4 Security posture

> ~~The dsh web server has **no TLS, no auth, and no origin policy** by its own README.~~ The "no origin policy" half is wrong — see below.

The dsh web server has **no TLS and no auth**. This is only acceptable because we bind `127.0.0.1` on an ephemeral port for a child process we own. Never expose the port, never set `--host 0.0.0.0`, and terminate the child on deactivate.

There *is* one fence the README does not mention: `/api` carries a Host-header trust list built by `resolveLanTrust` ([bundle/web-app/src/index.ts:78-85](../../../deepseek-harness/packages/bundle/web-app/src/index.ts#L78-L85)), an anti-DNS-rebinding measure. Its reasoning — "an IP-literal Host is safe on any port" — means our `http://127.0.0.1:<port>` origin passes without any `--trusted-host` configuration. Do not introduce a hostname alias for the base URL; that would put us on the wrong side of the fence for no gain.

## 5. Session-layer mapping — `ChatSessionItemController` ↔ `/api`

`registerChatSessionItemProvider` is deprecated; use `createChatSessionItemController`.

| VS Code | dsh `/api` | Notes |
|---|---|---|
| `items` | `session.list` | Backfill on activation. |
| `onDidChangeChatSessionItemState` | `host/session-added`, `host/session-removed`, `host/session-status` (host stream) | Live. |
| `createChatSessionItem(resource, label)` / `newChatSessionItemHandler` | `session.create` | Accepts `workspaceId` **or** `cwd`, not both. Pass the VS Code workspace folder as `cwd`. |
| `ChatSessionItem.label` | `session.rename`, and the session-title projection | |
| `ChatSessionItem.status` | `host/session-status` `running` → `InProgress`; `question/requested` and `approval/requested` → **`NeedsInput`** | `NeedsInput` is documented as "needs user input (e.g. an unresolved confirmation)" — an exact semantic match, not an approximation. |
| `ChatSessionItem.timing` | session-log timestamps | |
| `ChatSessionItem.changes` | *(derived)* | No direct projection. Deriving from streamed `textEdit`/`workspaceEdit` is preferred over accumulating it ourselves (§6). |
| `resolveChatSessionItem` → `ChatSession.history` | `session.history` | Pages backwards from the window tail via `beforeSeq`/`maxMessages`, on append-origin message boundaries. |
| `ChatSession.requestHandler` | `session.prompt` | `undefined` renders the session read-only — a genuinely useful degraded mode. |
| `ChatSession.activeResponseCallback` | mux stream for an already-running session | This is how a session the user did not start in this window still renders live. |
| `forkHandler` | `session.fork` | Both cut at a completed-turn boundary: VS Code "includes all turns upto this request turn and excludes this request turn itself"; dsh "maps an optional event anchor to the first `turn/end` at or after it". An open turn returns `fork-unavailable` → surface, do not swallow. |
| `ChatSessionCapabilities.supportsInterruptions` | `session.cancel` | dsh's cancel "aborts only the active turn and **preserves pending inbox work**" — which is precisely VS Code's "interrupted and resumed without side-effects". |
| `ChatSession.options` | `session.models` / `session.selectModel`, `agentPreset.list` / `agentPreset.select` | Model picker and preset picker in the session header. |

`/api` exposes 47 methods total; the above is the subset the session layer needs. `session.search`, `goal.*`, `skill.list`, `subagent.*`, `workspace.*`, and the settings/credentials plane are out of scope for M1–M5.

## 6. Stream-layer mapping — `ChatResponseStream` ↔ MuxFrame

Stable `ChatResponseStream` has only `markdown`, `anchor`, `button`, `filetree`, `progress`, `reference`, `push`. That is not enough. `vscode.proposed.chatParticipantAdditions.d.ts` supplies the rest.

| dsh MuxFrame / session event | `ChatResponseStream` |
|---|---|
| assistant text | `markdown` |
| reasoning | `thinkingProgress(thinkingDelta)` |
| tool call start / update | `beginToolInvocation(toolCallId, toolName, streamData?)` / `updateToolInvocation` — `streamData` carries `subagentInvocationId`, which maps onto dsh's subagent lineage |
| file edits | `textEdit` / `notebookEdit` / `workspaceEdit` / `externalEdit` — real editor edits, not rendered diffs |
| `question/requested` | **`questionCarousel(questions, allowSkip?)`** |
| `approval/requested` | `confirmation(title, message, data, buttons?)` |
| token usage | `usage(ChatResultUsage)` |
| `stream/error` | `warning` / `info` |

### 6.1 Questions — field by field

`questionCarousel` is a **blocking** call returning `Thenable<Record<string, unknown> | undefined>`. dsh's `ctx.userQuestions.ask()` is a blocking promise. Same lifetime model, no impedance matching — and the "carousel" is what dsh's own web UI already does ("one question at a time with progress navigation").

| `ChatQuestion` | dsh `AskUserQuestionRequest` |
|---|---|
| `id` | `id` |
| `type: Text \| SingleSelect \| MultiSelect` | `multiSelect` + presence of `options` |
| `title` | `question` / `header` |
| `message?: string \| MarkdownString` | `detail` — dsh renders it as GFM markdown too |
| `options?: { id, label, value }[]` | `{ label, description? }[]` — **the one lossy field**, see below |
| `defaultValue?: string \| string[]` | no default, but `(Recommended)` label suffixes drive a badge; map those |
| `allowFreeformInput?` | `custom` |
| `allowSkip` | "Skip this question" → `{ id, selected: [] }` |
| returns `undefined` | `ASK_CANCELLED` |
| returns `Record<string, unknown>` keyed by id | `answers: [{ id, selected, custom? }]` |

**Lossy field:** VS Code's option is `{ id, label, value }` with no description slot. dsh answers by option **label**, so map label → both `label` and `value`, synthesize `id`, and append `description` to the label. Accept the loss; do not invent a second UI for it.

**Validation to respect** (`/api` rejects otherwise with `bad-response`): multi-select may carry both `selected` and a non-empty `custom`; single-select must use one or the other; unknown or duplicate labels, mismatched ids, incomplete batches, and empty custom are all errors.

**Routing:** `intent.kind === 'plan-review'` → `confirmation(...)` with `[approve, refuse]` buttons. Everything else → `questionCarousel`. This mirrors what dsh's own UI does.

QuickPick is **not** needed as a fallback. It remains available for out-of-chat prompts only.

### 6.2 Caveats

- `ChatQuestion` is a **class**, not an interface — it must be constructed from the live `vscode` module, so it cannot be treated as a type-only import.
- `confirmation` carries `TODO@API should actually be a more generic function that takes an array of buttons` in the upstream source. Wrap it; do not call it from business code.

## 7. Milestones

Each milestone is independently reviewable and ends in a working state.

**M0 — scaffold.** `package.json` with `enabledApiProposals: ["chatSessionsProvider", "chatParticipantAdditions"]`, tsconfig, esbuild bundle, `vscode.proposed.*.d.ts` vendored, `argv.json` instructions in the README. Exit: ~~extension activates and logs.~~ extension activates and logs, **and `vscode.chat.createChatSessionItemController` is a function at runtime** — the added half is what proves §7.1 on the user's actual build.

**M1 — read-only.** `HarnessProcess` + `NodeApiClient` + `ConnectionController`. `ChatSessionItemController` backed by `session.list` and `session.history`, `requestHandler: undefined`. Exit: existing dsh sessions are listed and browsable in the sessions view. *This is the milestone that proves the transport; everything after it is mapping work.*

**M2 — live turns.** `requestHandler` → `session.prompt`, mux stream → `markdown` + `thinkingProgress` + tool invocations. `activeResponseCallback` for already-running sessions. Exit: a full turn renders live.

**M3 — interaction.** `question/requested` → `questionCarousel`; `approval/requested` → `confirmation`; both answered on POST `/api/respond` echoing the `rpcId`. `NeedsInput` status wiring. Exit: an approval-gated tool call round-trips.

**M4 — control.** `session.cancel` behind `supportsInterruptions`, `session.fork` behind `forkHandler`, `session.create`, model and preset pickers via `ChatSession.options`. Exit: cancel and fork work from the UI.

**M5 — packaging.** `vsce package`, per-platform VSIX only if a runtime is bundled, install and proposed-API instructions. Exit: a VSIX a stranger can install.

Do not start M2 before M1 renders real history. The transport is the only part that can fail in a way that invalidates the design.

### 7.1 The proposed-API gate — resolved

Open question 1 was the route's gating risk. It is **answered, and the answer is favourable**: `argv.json` alone is sufficient, and Microsoft's allowlist is not a gate.

Read from the shipped build, not from OSS source — **VS Code 1.133.0 stable, commit `a5b5009`, `Contents/Resources/app`**. The premise in the original open question was wrong twice over: the shipped `product.json#extensionEnabledApiProposals` is *not* empty (65 entries; `chatSessionsProvider` is granted to `GitHub.copilot-chat`, `GitHub.vscode-pull-request-github`, and `openai.chatgpt`), and membership in it is an **override**, not an entry requirement.

`ExtensionsProposedApi.doUpdateEnabledApiProposals` decides, in this order:

1. Drop any proposal name not in the build's proposal registry.
2. If the extension id is in `product.json` → **`product.json` wins and *replaces* the manifest list entirely.**
3. Otherwise keep the manifest's list if `_envEnablesProposedApiForAll || _envEnabledExtensions.has(id)`; else wipe it to `[]` and log `CANNOT USE these API proposals`.

with

```js
_envEnabledExtensions       = new Set(env.extensionEnabledProposedApi ?? [])   // ← argv.json "enable-proposed-api"
_envEnablesProposedApiForAll = !env.isBuilt
                            || (env.isExtensionDevelopment && quality !== 'stable')
                            || (_envEnabledExtensions.size === 0 && Array.isArray(env.extensionEnabledProposedApi))
```

Three consequences, in descending order of how much they change the plan:

- **Branch 3 is ours.** Listing our id in `argv.json` puts it in `_envEnabledExtensions`, and the manifest's `enabledApiProposals` survives. No Microsoft involvement. The route is not gated on anyone.
- **Extension development mode does *not* grant proposed API on stable.** The clause is `isExtensionDevelopment && quality !== 'stable'`. Running F5 / `--extensionDevelopmentPath` against the installed stable build gets nothing. This is a change from the older behaviour many guides still describe. **The `argv.json` entry (or `--enable-proposed-api <id>`) is a prerequisite for M0 development itself, not just for end users** — set it before writing the manifest, or M0 fails for a reason that looks like a code bug.
- Should we ever land in `product.json`, branch 2 replaces our list rather than merging it. Not a concern now; it is a trap if it ever happens.

Both proposals exist in 1.133.0's registry, so step 1 does not drop them. Vendor the `.d.ts` files from the **`1.133.0` tag**, not from `main` — the URLs embedded in the build point at `main`, which is ahead of what this build implements.

### 7.2 A second gate, newly found: the Agents window

`product.json` also carries `sessionsWindowAllowedExtensions` (26 entries — themes, Vim, ESLint, Prettier), consumed by `_isDisabledBySessionsWindow`. In a window running as `isSessionsWindow`, a non-builtin extension is disabled unless it is in that list or `canExecuteOnSessionsWindow(manifest)` holds — and that helper returns `false` for **any** extension declaring `main` or `browser`, which includes ours.

The escape hatch is a user setting, not a Microsoft list:

```jsonc
"extensions.supportAgentsWindow": { "<publisher>.deepseek-harness-sessions": true }
```

This does **not** affect the sessions view inside a normal workbench window, which is our target surface. It affects only the dedicated Agents window. Treat it as a documented second setting alongside `argv.json`, and verify during M0 which of the two surfaces the user actually means by "the list that holds `CLAUDE CODE` and `CODEX`".

### 7.3 M1 preconditions — spot-checked

Nothing here contradicts §4; recorded so M1 starts from checked ground rather than from the design sketch.

| Claim | Status |
|---|---|
| `AbstractApiClient` has exactly one abstract member | **Confirmed.** `protected abstract doFetch` at [apiproxy/src/fetch/client.ts:254](../../../deepseek-harness/packages/host/apiproxy/src/fetch/client.ts#L254), sole `abstract` in 549 lines. |
| `ConnectionController` is reusable as-is | **Present** at [connection/src/client/connection.ts](../../../deepseek-harness/packages/client/connection/src/client/connection.ts), 202 lines. Node-portability not yet proven — that is M1's actual work. |
| `session.list` / `.create` / `.history` / `.prompt` exist on the wire | **Confirmed** in [apiproxy/src/api/rpc-map.ts](../../../deepseek-harness/packages/host/apiproxy/src/api/rpc-map.ts); map keys are literally the POST path segments. |
| Port is discoverable without guessing | **Confirmed**, §4.1. |

Upstream is at `0.1.0-rc.5`, pnpm workspace, Node `^22.19.0 || >=24.0.0` — comfortably inside the extension host's Node, so the `global fetch` assumption in §4 holds.

## 8. Risks

| Risk | Severity | Handling |
|---|---|---|
| **Proposed API** — both `chatSessionsProvider` and `chatParticipantAdditions` are proposed. Cannot ship to the Marketplace; users need `enable-proposed-api` in `argv.json` and a restart. | ~~High, structural~~ High, structural — but **no longer a gating unknown** (§7.1) | VSIX distribution from GitHub Releases. This is the price of the route and it is the same price the alternatives charge for a worse result. Re-evaluate each VS Code release. |
| **Proposed API churn** — `chatSessionsProvider` is 849 lines and already contains one deprecation; `confirmation` carries a `TODO@API`. | High | Vendor the `.d.ts` files, pin the `engines.vscode` floor, adapter layer between VS Code types and our own. Never let a proposed type reach business code. |
| **Upstream `/api` churn** — six npm releases in four days; `/api` carries no stability promise, and upstream's own stance is "prefer the correct foundation over compatibility shims". | High | Version-gate at `host.describe`. Keep every schema in one directory so a resync is one diff. Expect to chase. |
| **No external PRs upstream** — `CONTRIBUTING.md` is explicit, and issues are disabled. | Medium | We own this port permanently; nothing lands upstream. Tag the repo `dsh-plugin`, which is the channel upstream actually invites. |
| **Version skew** with the user's own `dsh`. | Medium | Handshake check, named degradation, documented supported range. |
| **Trademark / official-looking naming.** | Medium | "Unofficial" in the description; personal publisher id; no `-community` land grab. |
| Web server has no auth. | Low, contained | Loopback + ephemeral port + child we own; never `0.0.0.0`. |

## 9. Competitive position

| | route | state |
|---|---|---|
| `skymecode/deepseek-harness-for-vscode` | webview + `/api`, isolated `DSH_HOME` | v0.4.0, 1★, one darwin-arm64 VSIX, tells users to paste the API key into `settings.json` |
| `bingchengle/deepseek-harness-vscode` | webview chat participant | v0.1.3, 15KB, one published VSIX |
| this | **chat session provider** | — |

Neither declares `enabledApiProposals`. Both reimplement the chat UI. **Nobody has taken the native-sessions route**, and it is the one that produces a UI worth using.

## 10. Open questions

1. ~~Does `chatSessionsProvider` require the extension id to be in the shipped build's `extensionEnabledApiProposals` allowlist, or does `argv.json` alone suffice?~~ **Answered — `argv.json` alone suffices; the allowlist is an override, not a gate. See §7.1.** The route is not gated on Microsoft. Confirm empirically at M0's exit anyway, since §7.1 is read from one build's minified source.
2. Does `activeResponseCallback` fire for a session that was already running before the window opened, or only for one this extension started?
3. Can a bundled-runtime fallback and the user's own `dsh` coexist in one install, or does the setting have to be exclusive?
4. *(new)* Is the target surface the sessions view in the normal workbench window, or the dedicated Agents window? Only the latter needs `extensions.supportAgentsWindow` (§7.2). Settle it at M0, since it decides how many setup steps the README must ask of a user.
