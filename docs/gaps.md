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

**Workaround:** the preset a session runs is surfaced as a standalone picker
(the "Pattern" chip), built from `agentPreset.list` and applied with
`agentPreset.select`. The roster is read live on every open and on every blank
composer, so a preset authored in Creator mode or installed by a plugin shows
up on the next session without an extension update. `agentPreset.select` only
works on a blank session — dsh answers `agent-preset-locked` once a turn has
run — so the chip is offered **only while the session is blank** and disappears
once the first turn has run, mirroring dsh's own composer, which offers the
preset picker only when creating a session. The tooltip still names the preset
too.

The "0-2" is guidance, not a limit: `refreshChatSessionPickers` renders one
widget per visible group with no cap, and this extension ships four — preset,
model, reasoning and permissions (§11).

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

**The editor's own permission control cannot be used.** `kind: 'permissions'`
looks like the right home — the editor folds such a group into its built-in
picker instead of spending a picker slot — but that picker never renders for
us. Its action is contributed with

```js
when: E.and(Z.enabled, Z.location.isEqualTo("panel"),
            Z.chatModeKind.notEqualsTo("ask"), Z.inQuickChat.negate(),
            E.or(Z.lockedToCodingAgent.negate(),
                 Z.lockedCodingAgentId.isEqualTo(qo.Background)))
```

and a composer locked to a coding agent — which is exactly what selecting a
third-party agent does — sets `lockedToCodingAgent` true and
`lockedCodingAgentId` to the agent's id. Only the built-in `Background` agent
passes. The action is therefore absent from `ChatInputSecondary`, so the widget
that would have called `getActiveExtensionPermissionGroup` is never created.
Declaring the kind hides the group and offers nothing in its place: this is the
same shape of closed gate as §9.

**Workaround:** `permissionGroup` in `src/sessions/options.ts` builds an
ordinary standalone picker with a shield icon. Nothing caps the number of
pickers — `refreshChatSessionPickers` renders one widget per visible group, so
the documented "0-2 groups" is guidance rather than a limit — and model,
reasoning and permissions render as three. Selecting an option runs the
command; the resulting projection frame rebuilds the group, so a preset changed
from dsh's web UI or another window moves the picker too.

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

## 14. Assigning `ChatSessionInputState.groups` from its own change handler never terminates

The setter is, verbatim:

```js
set groups(t){ this.#e = t; this.#t?.() }
```

No equality check, and `#t` is the notifier that pushes the groups to the
workbench. The workbench applies the user's selection to them and calls back
`_setGroups(u); c._fireDidChange()` — which fires `onDidChange` again. So the
natural-looking shape

```ts
state.onDidChange(() => { state.groups = rebuild() })   // ← unbounded
```

is a feedback loop between the extension host and the workbench. Observed cost:
a pinned CPU core, and the extension host dying after three or four clicks in a
picker. Nothing in the proposal warns about it, and the symptom looks like a
crash in whatever the handler happens to call.

**Workaround:** `SessionContent.setGroups` compares before assigning
(`sameGroups` in `src/sessions/options.ts` — group ids, item ids, selected
ids). The echo then finds nothing to change and the exchange stops after one
round trip. Every write to `groups` in this extension goes through it.

Two consequences worth keeping in mind:

- A picker cannot be "corrected" by rewriting the same value; the workbench
  already holds the user's choice, and writing it back is a no-op by design.
- On a blank chat the choice has nowhere to be confirmed against, so the held
  record *is* the current value until a session exists. Rebuilding those groups
  from the host defaults made every selection snap back the moment it was made.

## 15. A crashed extension host orphans the harness

`HarnessProcess.stop` SIGTERMs the child and escalates to SIGKILL after five
seconds, and `dispose` calls it — but neither runs when the extension host
dies, and the child is reparented to `init` rather than following it. Each
crash therefore leaves a `dsh web` behind, holding ~40-140 MB and its own port.
Four accumulated during one afternoon's debugging.

They are idle, so they cost memory rather than CPU, and dsh's own storage
locking keeps them from corrupting each other. There is no `--parent-pid` or
equivalent on `dsh web` to make the child exit with its parent.

**Workaround:** none in the extension; they must be killed by hand. Worth
revisiting if dsh ever grows a parent-liveness option.

## 16. The editor's slash commands are a proxy, because `session.prompt` is not the one

dsh's web composer intercepts a `/`-line and runs it through the command
registry; the editor now does the same, but the interception lives in the
extension rather than in dsh. `session.prompt`'s contract promises that "a
prompt whose content is exactly one text block starting with `/` is a slash
command … never sent to the model", and it is not implemented by the running
build (§12) — so without a proxy, `/permission read-only` typed in the editor
reaches the model as an ordinary prompt and costs a turn.

**The proxy** (`src/slash/proxy.ts`) intercepts a request in
`SessionContent.handlerFor` when three things hold at once:

- the prompt content is exactly one text block,
- that block is the trimmed prompt itself — attachment context is appended to
  the prompt text, so a clean command line exists only when nothing else was
  mounted,
- the parsed `/name` resolves in the session's `commands/list` catalog.

It then runs `commands/execute` on the remotes plane and renders the outcome
inline — no `session.prompt`, no turn, no model. An unknown `/foo` is *not*
intercepted and flows to the model as an ordinary prompt, which is exactly what
dsh's own composer does with it.

The `commands/list` catalog is read live per session and cached for 30 s,
cleared on every reconnect (a reconnected harness may compose different
plugins). A Command Palette entry — **DeepSeek Harness: Run Slash Command…** —
picks a session, picks from that live catalog, fills the advertised argument
hint, and runs the same `commands/execute`.

One nuance of the remotes plane: `commands/execute` answers `ok: true` even
when the command's own outcome is an error (its text rides `result.text`), and
answers `value: undefined` for a line no command matched. The proxy folds those
into distinct outcome kinds so a transport failure, a command error and an
unknown line render differently instead of collapsing into one error path.

**The composer's `/` dropdown cannot be fed live.** The dropdown lists the
agent's `slashCommands`, and the editor fixes those at registration, from the
`chatSessions` contribution — `slashCommands: e.commands ?? []` in
`_registerAgent` — while `updateAgent` merges only `metadata`. So nothing an
extension does at runtime can add a command to the dropdown, and with no
`commands` contributed the dropdown showed only the editor's own entries.
What *is* live is each contributed command's `when` clause:
`registerAgent` wraps `slashCommands` in a getter that filters against the
global context key service on every read.

**Workaround:** the built-ins this dsh generation ships — `plan`, `compact`,
`permission`, `goal`, `export`, `feedback` — are contributed statically, each
guarded by `when: "deepseekHarness.command.<name>"`, and `SlashProxy` sets
those keys from every `commands/list` it reads (the catalog is warmed when a
session opens, so the keys are live before the first `/` is typed). A command
the running dsh does not advertise never shows; one it gains beyond the static
list still executes when typed — the prompt-interception path is unchanged —
it just cannot appear in the dropdown. Context keys are global while the
catalog is per-session, so the most recently read catalog wins; the dropdown
is advisory either way, because execution re-resolves the line on the exact
session.

**A picked command changes the request's shape.** When the user submits a
command the editor recognises — picked from the dropdown or typed against the
contributed list — the parser puts the name in `request.command` and strips it
from `request.prompt`. A handler that reads only the prompt therefore sends
the bare *arguments* to the model as an ordinary prompt. `handlerFor` rebuilds
the line from `request.command` first and proxies it unconditionally: the user
explicitly picked a command, so one this dsh turns out not to own renders as
"unknown command" rather than costing a turn.

## 17. The tail page of a long session folds to turns the editor silently drops

Two behaviours compose into an empty transcript after a window reload:

- `session.history` pages by *message* count (§1), and one agentic turn can
  span dozens of assistant messages — so the tail page of a long session is
  often mid-turn, holding assistant messages and tool events but **no human
  prompt at all**.
- The workbench rebuilds a provided session by walking its history and
  attaching each response turn to the last request turn seen — literally
  `else if (U)` in the restore loop: a response turn arriving before any
  request turn is dropped without a trace.

Fold a promptless tail page and every turn it yields is a leading response
turn; the editor drops all of them and the session opens empty. Before the
reload the transcript was visible because the live window had accumulated it
turn by turn; the reload forces a rebuild from `session.history`, which is
when the composition bites.

**Workaround:** `readHistory` pages backwards with `beforeSeq` until a page
carries a human prompt — `isHumanPrompt` in `src/sessions/history.ts`, the
same predicate the fold opens request turns with, so "worth stopping for" and
"renders as a request" cannot drift apart. The loop is bounded at 20 pages so
one pathological turn cannot pull a whole multi-hundred-megabyte log; hitting
the bound reproduces the old mid-turn drop, logged this time. Pages are
de-overlapped by `seq` when assembled, so an inclusive `beforeSeq` reading
could not duplicate the boundary message.

**Wanted:** same as §1 — a projection of the surface rather than the log. A
`session.history` that paged by *human turns* would also close it.

## 18. One bad row makes the whole session unreadable, and the editor shows nothing

dsh's log scanner requires every event's `seq` to be exactly contiguous, and
the moment a `turn/end` row follows any inconsistency it refuses the entire
session: `session.history` answers `internal: history unavailable … corrupt
session log` for **every** window, even ones far from the bad row. The log can
be 99% coherent — one observed case had 13 duplicated seqs out of 62,098
events — and none of it is served.

Such logs exist because nothing serializes writers. dsh does not lock a
session's log file, and this extension *always* starts its own harness — so a
terminal `dsh web` and the editor holding the same session is an ordinary
setup, and two processes appending with independent seq counters is one
interrupt away. The observed collision: one process recorded a turn as
interrupted and ran slash commands (13 rows), while the other, still running
that turn, appended its real `tool/result` from a stale counter and carried
on for 47,000 more events.

The extension cannot recover what dsh refuses to serve, and §17 explains why
it cannot even say so *inside* the transcript: a history holding only response
turns is dropped wholesale, so there is no turn to carry an error.

**Workaround:** when the first history page fails — nothing to render at
all — `readHistory` raises a warning notification carrying dsh's own error
message, so an empty transcript is at least labelled with its cause. A
failure after some pages arrived still renders the torn tail and only logs.

**Wanted:** two things in dsh. Serve the coherent prefix (the scanner already
computes it) instead of refusing the session; and a single-writer guarantee —
a lock file, a lease, anything that makes the second harness fail loudly
instead of corrupting silently.

## 19. The editor's own slash commands leak into every session's dropdown

Four entries in the `/` dropdown — `/fork`, `/debug`, `/models`,
`/vscode-pet` — are not ours and cannot be removed. They are workbench-core
registrations in a *global* slash-command registry (a separate completion
source from the participant's `slashCommands`), and a registration that
declares no `sessionTypes` matches **every** contributed session type. The
editor's own scoped commands (`/tools`, `/agents`) declare
`sessionTypes: [local]` and stay out; these four do not. There is no opt-out
for a session-type contribution — the only per-command gate is the
registration's own `when`, which only `/fork` carries.

None of them ever reaches the participant: they are registered
`silent: true`, so the parser turns the line into a *global* slash part and
the request short-circuits into the core handler before the agent is invoked
— no `request.command`, no request bubble. What each one actually does on a
dsh session:

- **`/fork`** runs `workbench.action.chat.forkConversation`, which for a
  contributed session calls the session's fork support — the
  `forkHandler` this extension registers on the item controller, so it forks
  through `session.fork` like the transcript's own fork affordance. Its
  `when` (`lockedToCodingAgent.negate() ∨ chatSessionSupportsFork`) means it
  only shows on our sessions *because* that handler is registered.
- **`/debug`** runs `github.copilot.debug.showChatLogView` — a Copilot Chat
  command. With Copilot Chat installed it opens *Copilot's* log view;
  without, it fails with "command not found". Nothing here can fix it:
  the id belongs to another extension, and registering it ourselves would
  make that extension's activation throw the day it is installed.
- **`/models`** runs `workbench.action.chat.openModelPicker`, which shows the
  composer's *native* model picker widget — a control that is only created
  for sessions whose contribution declares `requiresCustomModels`, and is
  otherwise `undefined`, making the command a silent no-op. Declaring that
  flag would not help: the native picker's items come from the editor's
  language-model service filtered to models registered *for this session
  type* — a channel this extension does not feed, because dsh's models are
  proxied, not editor language models — so the flag buys an empty picker
  reading "No models available" and suppresses the default model with it.

  **Workaround:** the parser checks the locked participant's *own* commands
  before the global registry, so contributing our own `models` command
  shadows the editor's at parse time: a typed or picked `/models` arrives as
  `request.command` and opens dsh's catalog (`session.models` →
  `session.selectModel`, in `src/model-picker.ts`), then pulls the open
  composer pickers along. The cost is cosmetic — the dropdown lists both
  entries, ours (which works) and the editor's (which stays a no-op),
  because the global list cannot be filtered per session type. The shadow
  yields to dsh: a catalog that ever advertises `models` is proxied like any
  other command.
- **`/vscode-pet`** toggles a workbench-built-in easter egg (the "pet"
  service is core, despite the experimental label). It works; it just has
  nothing to do with the session.

**Wanted:** either `sessionTypes` on the core registrations, or a
per-contribution opt-out, so a contributed session's dropdown lists only
commands that mean something there.

## 20. There is nowhere to put a session button

A control panel for a session was built and then removed — the entry points
the editor allows were not worth their costs. The findings stay, because
they constrain any future button:

- Not contributable at all (absent from the workbench's whitelist of menus
  `package.json` may target): the chat view's session title bar
  (`ChatViewSessionTitleToolbar` and its navigation twin) and the composer's
  own toolbars (`ChatInput`, `ChatExecute`, `ChatInputSecondary`, the
  attachment toolbar around `+`).
- **`chat/input/status`** is whitelisted (no proposal gate; `when` evaluated
  against the composer's scoped keys, so `chatSessionType` scopes it), but
  its toolbar context is not marshallable: the command arrives with no
  argument and cannot know which session's composer was clicked.
- **`editor/title`** works for a session opened as an editor tab (input type
  `workbench.input.chatSession`), scoped by `resourceScheme` — but only for
  tabs. `chatSessionType` is widget-scoped and does not resolve there.
- **An option group** is the one contribution that reaches the picker row: a
  group may carry `commands`, rendered as dropdown rows that are handed
  `{ inputState, sessionResource }` — the only composer entry point that
  knows its exact session. Its price: the group only renders on a live
  session once a session option is recorded for it, so it must carry an
  always-selected item that does nothing; a chip's label is text or a
  ThemeIcon, never a custom border; and the dropdown has no filter input.
- A status bar button is window-global and can never know its session; a
  QuickPick can search but cannot be anchored to the composer or sized to
  the sidebar. Anything panel-shaped and anchored is webview territory,
  which the native composer does not host.

**Wanted:** the session title toolbar in the contributable-menu whitelist,
or a marshallable session context on the composer's toolbars.

## 21. The harness picker renders theme icons only, and brand logos are a private map

The composer's harness picker (the chip naming the provider, and its
dropdown) ignores a contribution's `{light, dark}` image icon outright: its
icon resolver takes the contribution's icon only when it is a *ThemeIcon*,
and falls back to the `extensions` codicon otherwise — the rendering path
sets CSS class names and nothing else, so a file URI cannot survive it. The
brand logos it does show (Codex, Claude, Copilot) come from a hardcoded map
keyed on built-in session-type ids; there is no hook for a third-party type
to join it.

**Workaround:** ship the icons as a font. `contributes.icons` registers
ThemeIcons backed by `media/dsh-icons.ttf`, generated from dsh's own SVG
art: the whale (`U+E001`, from `media/dsh-whale.svg`) and the three
permission-preset glyphs of dsh's design set 1556 (`U+E002..E004` —
shield+check, shield+pencil, shield+exclamation, stroke outlines converted
to fills). The `chatSessions` contribution's `icon` names the whale as a
string — the schema's string form resolves to a ThemeIcon and renders
everywhere the picker does — and the composer chips carry the rest per
item, mirroring dsh's exact preset-value mapping with the plain shield for
presets outside it. The cost: a font glyph is monochrome, drawn in the
theme's icon foreground — which this art is designed for anyway
(`currentColor` throughout). The editor tab and welcome view, which *can*
render image files, render the ThemeIcons too, so one declaration serves
every surface.

One trap: the running VS Code app caches the icon font by URL for its own
lifetime, across every window reload — a glyph added to the file under the
same name renders only after a full app restart, while glyphs the cached
copy already had keep working (and a codepoint missing from it draws the
empty `.notdef`, i.e. nothing at all, which looks exactly like a data bug
elsewhere). After changing the glyph set, restart the app fully — or, while
developing, rename the file temporarily so the URL changes with it.

**Wanted:** the picker honouring the contribution's image icon, or a
registration hook into the brand map.

## 22. A response footer gets one string, and its toolbar is closed to session providers

What the editor renders under a finished response is a timestamp, a bullet,
and `ChatResult.details` — one flat string, no markdown, no hover. The
timestamp is the verbose half: it appears only with `chat.verbose` on, while
`details` always does. So `details` is the whole of what a turn can say about
itself, which is why `describeTurn` puts the model *and* the token counts in
it rather than leaving either to a richer surface.

- **`stream.usage()` is accepted and goes nowhere visible.** The response
  model stores it, and the footer's token-stats hover is built from
  `usage.modelTotals` — a field `ChatResultUsage` does not have.
  `promptTokenDetails` has the same problem: it feeds a breakdown panel
  reached from surfaces a locked session does not render. The call is kept
  anyway (it is the honest report of what the turn cost, and it is what a
  future hover would read), but nothing shows it today.
- **Retry, Helpful and Unhelpful cannot appear.** All three are registered
  into `MenuId.ChatMessageFooter` with `when: … lockedToCodingAgent.negate()`,
  and opening a session of *any* contributed type calls `lockToCodingAgent`,
  which sets that key. Report Issue escapes the lock but needs
  `supportIssueReporting`, which lives on the `chatParticipantPrivate`
  proposal. Copy is the one action left ungated, and Read Aloud joins it only
  when a speech provider is installed — which is exactly the one-button
  footer the transcript shows.
- **The menu is not contributable either.** `chat/message/footer` is absent
  from the workbench's whitelist of menu ids `package.json` may target, so a
  retry command cannot be added from this side. The nearest reachable
  affordance is `stream.button()`, which renders inside the response body
  rather than in the footer, and which the transcript fold would drop on the
  next window reload.

There is also no dsh command behind such a button: the command registry has
no retry or rewind, and re-sending the prompt would append a second turn
rather than replace the first, which is not what the editor's Retry means.

**Wanted:** `ChatMessageFooter` in the contributable-menu whitelist, or a
`ChatSessionCapabilities` flag that opts a provider into the retry action;
and `modelTotals` on `ChatResultUsage` so the token panel can be filled.

