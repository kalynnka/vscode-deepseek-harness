# Gaps between what the chat UI wants and what dsh's `/api` offers

Every entry here is something the extension wanted, could not get, and worked
around — recorded so the workaround is a known decision rather than a mystery,
and so the list can be taken upstream if a channel ever opens. Nothing here is
speculative: each was found by running against a real dsh.

Measurements are from `npm run smoke` against dsh `0.1.0-rc.5`.

## 1. `session.history` cannot exclude `assistant/chunk`, and they are ~100% of the payload

`session.history` pages on message boundaries and returns every raw event those
messages own, including token-level `assistant/chunk` records. For one real
session:

| `maxMessages` | events | of which chunks | JSON size |
|---|---|---|---|
| 5 | 729 | 707 (97%) | 129 KB |
| 20 | 60,727 | 60,635 (100%) | 10.2 MB |
| 60 | 84,128 | 83,938 (100%) | 15.3 MB |

The extension discards every one of them: the committed `assistant/message`
carries the same text, so replaying deltas would duplicate the whole
conversation. We therefore transfer 15 MB to render what is contained in ~200
events.

**Wanted:** a request flag on `session.history` — `includeChunks: false`, or a
projection of the surface rather than the log.

**Workaround:** `deepseekHarness.historyPageMessages`, defaulting to 10 rather
than to a comfortable number. Opening a long session is a visible pause.

## 2. No history slot for reasoning

`ChatResponseTurn2.response` accepts no thinking part, so reasoning blocks are
dropped when rebuilding a past conversation. Live turns render reasoning
through `ChatResponseStream.thinkingProgress`, which has no historical
counterpart.

This is a VS Code gap rather than a dsh gap — dsh stores reasoning perfectly
well — but the effect on the user is the same: reasoning is visible while a
turn streams and gone when the session is reopened.

**Workaround:** none. Reasoning is live-only.

## 3. Injected context messages have no faithful rendering

dsh writes file-change notices, skill bodies, `AGENTS.md` content and cron
notifications as `user/message` events whose `source.kind` is `plugin` or
`tool` rather than `user`. They are genuinely on the model-visible surface, but
attributing them to the human in the transcript would misrepresent the
conversation, and the chat model has no "system-injected context" turn.

**Workaround:** they are skipped in history. `messageSourceKind` in
`src/dsh/events.ts` is the discriminator, so a future rendering has one place
to hook into.

## 4. `confirmation()` cannot answer a blocking approval

The plan mapped `approval/requested` onto `ChatResponseStream.confirmation`,
which is the part that *looks* like an approval prompt. It is the wrong shape:
`confirmation` returns `void`, and the user's verdict arrives on the **next**
chat request as `ChatResult.acceptedConfirmationData` /
`rejectedConfirmationData`. That fits a participant that can wait until the
user types again; it does not fit dsh, where a tool is blocked on the answer
and nothing else will happen until it comes.

`questionCarousel` is the only primitive whose lifetime matches: it returns a
`Thenable` that settles when the user answers, exactly like dsh's
`ctx.userQuestions.ask()`.

**Workaround:** approvals are rendered as a single-select question — *Allow
once* / *Reject* — in `askApproval` (`src/sessions/interaction.ts`). The cost
is cosmetic: an approval looks like a question rather than getting the
confirmation part's dedicated styling and its "Accept All" affordance.

Plan-review questions (`intent.kind === 'plan-review'`) take the same path for
the same reason, with the intent's named `approve` option preselected.

## 5. The carousel's answer shape is not pinned by the proposal

`questionCarousel` returns `Record<string, unknown>` keyed by question id, and
the proposal does not say what one value looks like. Guessing cost a full
round trip: the first implementation read `values`/`selected`/`value` and
`custom`/`text`/`freeform`, none of which exist, so every answer reached dsh
empty and the agent replied "No selection came through".

The actual contract, read from the workbench's `yGo`:

| Question type | Value at `result[questionId]` |
|---|---|
| `Text` | a bare `string` |
| `SingleSelect` | `{ selectedValue, freeformValue? }` |
| `MultiSelect` | `{ selectedValues: string[], freeformValue? }` |

The selection carries the **option's `value`**, validated against
`new Set(options.map(o => o.value))`. That is why `toChatQuestion` puts the
pristine dsh label in `value` and folds the description into `label` for
display only — the answer maps straight back with nothing to parse out.

**Workaround:** `readAnswer` in `src/sessions/interaction.ts` reads the real
fields and keeps the looser branches as a fallback. `askApproval` goes through
the same reader rather than its own, so a future shape change cannot fix
questions while silently leaving approvals broken. The raw result is logged on
every answer, because a change here surfaces as a dsh-side complaint with
nothing in the extension to point at.

## 6. Only two option groups, and three things want one

`ChatSessionProviderOptions.optionGroups` is documented as "0-2 groups
supported". Model and reasoning effort take both, so **agent presets have no
place in the session header**, even though dsh exposes `agentPreset.list` and
`agentPreset.select` and records the resolved preset on the session header.

**Workaround:** none yet. The preset a session runs is shown in its tooltip so
it is at least visible; switching it is not offered. A command is the obvious
home for it if it is wanted.

The budget covers *standalone pickers* only. A group declaring
`kind: 'permissions'` is skipped by the picker loop —
`if (n.kind === "permissions") continue` — and read separately by
`getActiveExtensionPermissionGroup`, so the permission preset (§11) costs
nothing from the two. There is no equivalent kind for agent presets.

## 7. MCP servers are not on `/api` at all

dsh has an MCP plane, and none of it is reachable over `/api`: the 47-method
`RpcMethodMap` has no `mcp.*` entry. So the extension cannot list configured
servers, show their status, or enable one for a session.

**Workaround:** skipped entirely, per the rule that nothing about the user's
dsh is hardcoded here. dsh applies its own MCP configuration server-side, so
the tools still work in a turn — they are simply not inspectable from the
editor.

## 8. Skills are listable but have no session surface

`skill.list` exists, but skills are applied by dsh itself when it assembles a
request; there is no per-session "use this skill" call to bind a picker to, and
the chat session API has no skills affordance.

**Workaround:** not surfaced. `skill.list` is declared in
`src/dsh/wire.ts` so the call is one line away if a surface appears.

## 9. A third-party session type cannot have its own tab

The Agent Sessions tab strip — `CHAT | CLAUDE CODE | CODEX` — is not built from
the `chatSessions` contributions. It is built from a **closed allowlist** of
session types baked into the workbench:

```js
function Of(s){ switch(s){
  case Local: case Background: case Cloud: case Codex:
  case AgentHostCopilot: case AgentHostClaude: case AgentHostCodex:
    return s
  default: return          // every third-party type, including ours
}}
```

`_updateAgentSessionItems` pushes a contribution only when `Of(a.type)` is
truthy, so `deepseek-harness` is filtered out. Codex has a tab because the
string `openai-codex` is hardcoded in that enum; Claude Code via
`agent-host-claude`.

What a third-party contribution *does* get is an automatic chat **agent**
registration (`resolveChatSessionContribution` → `registerAgent` with
`isDynamic: true, locations: ["panel"], modes: ["agent", "ask"]`), which is why
DeepSeek Harness appears in the Chat composer's agent picker instead. That is
the intended third-party surface in 1.133.0.

**`canDelegate: true` is mandatory, and nothing says so.** Both that agent
registration and the per-type `New <name> Session` commands are behind one
flag:

```js
_enableContribution(e, t) {
  this._contributionDisposables.set(e.type, i)
  e.canDelegate && (i.add(this._registerAgent(e, t)), i.add(this._registerCommands(e)))
  i.add(this._registerMenuItems(e, t))
}
```

The contribution schema documents `canDelegate` as an ordinary optional
boolean. Omit it and the session type registers, the content provider is
called for `untitled-` resources, and **no command exists to start a session** —
`openNewSessionEditor.<type>`, `openNewSessionSidebar.<type>`,
`openNewChatSessionInPlace.<type>` and `openSessionWithPrompt.<type>` are all
absent, with no warning. The symptom is an extension that appears to load
perfectly and cannot be used.

**Workaround:** none that is legitimate. Claiming one of the reserved ids — via
`type` or the contribution's `alternativeIds` — would impersonate Codex or
Claude Code and capture their sessions. Re-check `Of` on each VS Code upgrade;
this is the single change that would most improve the extension's standing.

## 10. Prompt content is text or image, so an editor attachment has to be prose

The editor mounts context the user never types — the pinned chip for the active
selection, files dropped on the composer, `#`-references, pasted images — and
delivers all of it in `ChatRequest.references`. None of it is in
`request.prompt`. A handler that sends only the prompt drops every attachment
without a trace, which is precisely what it looks like from the other side: the
composer shows a chip and the agent has never heard of the file.

dsh's own content model has no slot for a structured reference:

```ts
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
```

So a reference has to be *rendered*. `src/sessions/references.ts` does it, and
the choices are worth stating because they are not the only ones possible:

| Reference | Sent as |
|---|---|
| `Location` (a selection) | path, line range and the selected text, inlined |
| `Uri`, saved file | the path only |
| `Uri`, `untitled:` scheme | the buffer's text, inlined |
| binary data | an `image` part when the media type is one dsh accepts |
| `string` | the value under the reference's name |

A selection is inlined because a range is editor state that dsh cannot go and
read for itself; a saved file is named rather than inlined because dsh runs in
the same workspace with its own read tools, and inlining would spend context on
a file it may not need to open. Both are capped at 8000 characters, since
"select all" is one keystroke.

Paths are relative to the **session's** `cwd` as reported by `session.list`,
not to the editor's workspace root — that is the directory the agent's tools
resolve against, and the two are not always the same.

**Wanted:** a `resource` content part, so a file reference travels as a
reference and dsh decides how to read it.

## 11. Permissions have no RPC; the preset is switched with a slash command

The 47-method `RpcMethodMap` has no `permission.*` entry, and yet the preset is
per-session state the user must be able to see and change — the difference
between an agent that asks before writing and one that does not.

Both halves exist, just not as calls:

- **Reading** is a projection. `permissions` carries
  `{ options: PresetOption[], currentValue: string }`, folded from the
  `permission/preset`, `sandbox/mode` and `approval/policy` knob events over
  the deployment's preset table. Key absence means no permission service is
  composed, and the control must then disappear rather than show a guess. The
  derived `custom` value appears in `options` only while it is current, and it
  is a state rather than a target.
- **Writing** is the `/permission <preset>` command — but *not* through
  `session.prompt`. See §12: the slash-command interception that
  `session.prompt`'s contract describes is not implemented, so that line
  reaches the model as an ordinary prompt and costs a turn. The command
  registry answers on the remotes plane instead:

  ```
  POST /api/commands/execute
  { "type": "client-request", "rpcId": "…", "method": "commands/execute",
    "payload": { "args": { "agentId": "<sessionId>", "line": "/permission read-only" } } }

  → { "ok": true, "value": { "commandId": "cmd-…-1",
                             "result": { "kind": "success", "text": "preset read-only" } } }
  ```

  Measured against dsh at `apps/cli/lib/bin.js`: two `permissions` projection
  frames follow, `currentValue` becomes `read-only`, and the session stays
  `blank` — a command opens no turn, so this costs nothing.

**Workaround:** `permissionGroup` in `src/sessions/options.ts` builds an option
group with `kind: 'permissions'`, which the editor folds into its own chat
permission picker rather than rendering as a third standalone one (§6).
Selecting an option runs the command; the resulting projection frame rebuilds
the group, so a preset changed from dsh's web UI or another window moves the
picker too.

A dsh that offers no `/permission` command answers with `value: undefined`.
`applyPermission` reports that rather than falling back to a prompt — asking
the model to change a setting it does not own would spend a turn and change
nothing.

## 12. `/api` has a second RPC plane, and nothing announces it

`RpcMethodMap` is presented as the API — 47 methods, flat payloads,
`POST /api/<method>`. It is not the whole of `/api`. dsh's typert **remotes**
ride the same transport under `<namespace>/<method>` endpoints, with arguments
wrapped in `args`:

```
POST /api/commands/list      payload: { args: { agentId } }
POST /api/commands/execute   payload: { args: { agentId, line } }
```

Nothing in the method map, the rpc-map header or the `/api` contract mentions
them; they were found by following dsh's own client from `session.command()`
through `remote.commands.execute` to `connection.rpc.call('/api', endpoint, …)`.

This matters beyond permissions: `commands/list` on a real session answers

```
compact, export, feedback, goal, permission, plan
```

so context compaction, plan mode and goals are all reachable from the editor,
and none of them are in the documented method map.

**Related, and the reason this was found the hard way:** `session.prompt`'s
contract states that "a prompt whose content is exactly one text block starting
with `/` is a slash command: the host executes it through the command registry
and it is never sent to the model", returning a `command` slot. The running
build does no such thing — its `prompt` handler goes straight to
`durablePromptContent` and `agent.followup`. A `/permission read-only` sent that
way was accepted, started a real turn, and left the session non-blank. The
`command?` field is kept in `src/dsh/wire.ts` because the contract declares it,
but nothing may rely on it.

**Workaround:** `DshApiClient.remote()` types the endpoints this extension
uses. It is deliberately a separate method from `call()` — the two planes have
different addressing and different payload envelopes, and blurring them would
hide which contract a given line depends on.

## 13. The composer's pickers come from the controller, and nothing says so

`ChatSessionContentProvider.provideChatSessionContent` receives a
`ChatSessionInputState` in its context, and setting `groups` on it is what puts
model and reasoning pickers in a session's composer. It is easy to conclude
that this is *the* way option groups are published. It is not, and the
difference is invisible until a user opens a new chat and finds a composer with
no controls on it at all.

The pickers are a **controller** hook:

```ts
controller.getChatSessionInputState = (sessionResource, context, token) => …
```

and the resource it hands over is `undefined` for any chat with no session yet.
The editor maps untitled resources to `undefined` itself before calling —
`getChatSessionInputState(Zc(a) ? void 0 : a, …)` — so an untitled resource
never arrives, and there is no key to remember a per-editor choice against.

The returned state must be built with
`controller.createChatSessionInputState(groups)`; a plain object is not
accepted. The editor then stamps `sessionResource` or `untitledSessionResource`
onto it.

**Workaround:** `SessionContent.provideInputState`. For a session that exists
it wires the same pickers as before. For a blank chat it reads what dsh can
answer without a session — `llm.models` for the catalog, and the `permission`
settings namespace for the preset a new session will start with — and holds the
user's choices until `bind` creates the session, which applies them with
`session.selectModel` and `/permission`.

Two details that are not obvious:

- **The model group carries no selection on a blank chat.** Nothing advertises
  which model a not-yet-created session will use: `agent-loop` holds only
  `maxParallelToolCalls`, and there is no `defaultModel` anywhere in
  `settings.describe`. Preselecting the first catalog entry would show the user
  one model and then run another, so the picker is offered unselected.
- **The same input state object reaches both hooks.** The controller hook and
  the content provider are handed the same object, so wiring both would apply
  every picker change twice. `wired` (a `WeakSet`) makes the second caller a
  reader.

An enum in `settings.describe` lives in the schema, not the value. The schema is
a serialized schemastery envelope — `{ uid, refs }`, a graph of numbered nodes —
so the presets are read by walking the root object's `dict.defaultPreset` to a
`union` of `const` nodes. `enumChoicesAt` in `src/sessions/defaults.ts` does
that walk; the resolved `value` only says which one is currently set.
