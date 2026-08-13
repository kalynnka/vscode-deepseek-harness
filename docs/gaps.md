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
the proposal does not say what one value looks like — a bare string, an array
for multi-select, or an object carrying the free-form text beside the
selection are all consistent with the declaration.

**Workaround:** `readAnswer` in `src/sessions/interaction.ts` accepts all of
them and normalises to dsh's `{ selected, custom }`, sorting values into
"selected" or "custom" by whether they match a known option label. This is the
most likely place for a VS Code update to break behaviour without breaking the
build.

## 6. Only two option groups, and three things want one

`ChatSessionProviderOptions.optionGroups` is documented as "0-2 groups
supported". Model and reasoning effort take both, so **agent presets have no
place in the session header**, even though dsh exposes `agentPreset.list` and
`agentPreset.select` and records the resolved preset on the session header.

**Workaround:** none yet. The preset a session runs is shown in its tooltip so
it is at least visible; switching it is not offered. A command is the obvious
home for it if it is wanted.

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
