import * as vscode from 'vscode'
import type { DshApiClient } from '../dsh/client'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, RpcId, SessionId } from '../dsh/wire'

/**
 * Turns dsh's blocking interactions into blocking chat UI, and sends the
 * answers back.
 *
 * Both questions and approvals go through `questionCarousel`, which is the only
 * primitive whose lifetime matches theirs: it returns a Thenable that settles
 * when the user answers, exactly as dsh's `ctx.userQuestions.ask()` and its
 * approval gate block a waiting tool.
 *
 * `confirmation()` looks like the natural fit for an approval and is not one.
 * Its verdict does not come back through a promise — it arrives on the *next*
 * chat request, in `acceptedConfirmationData`. A tool blocked on an approval
 * would sit there until the user happened to send another message. See
 * docs/gaps.md §4.
 */

/** The answer a carousel produced, already in dsh's shape. */
type Answers = AskUserQuestionAnswerItem[]

/**
 * Maps one dsh question onto a `ChatQuestion`.
 *
 * The lossy edge is options: VS Code's option is `{ id, label, value }` with no
 * description slot, while dsh's is `{ label, description? }` and answers are
 * matched back by label. So the label carries the description, and `value`
 * carries the pristine label that must be echoed.
 */
function toChatQuestion(item: AskUserQuestionItem): vscode.ChatQuestion {
  const options = item.options?.map((option, index) => ({
    id: `${item.id}:${String(index)}`,
    label: option.description === undefined || option.description === ''
      ? option.label
      : `${option.label} — ${option.description}`,
    value: option.label,
  }))

  const type = options === undefined || options.length === 0
    ? vscode.ChatQuestionType.Text
    : item.multiSelect === true
      ? vscode.ChatQuestionType.MultiSelect
      : vscode.ChatQuestionType.SingleSelect

  const title = item.header === undefined || item.header === '' ? item.question : item.header
  const message = buildMessage(item)

  return new vscode.ChatQuestion(item.id, type, title, {
    message,
    options,
    // dsh has no default, but its convention is a "(Recommended)" label
    // suffix; honouring that preselects what the agent actually recommends.
    defaultValue: recommendedOptionId(item, options),
    // dsh calls this `custom`, and it is valid alongside a multi-select
    // selection but exclusive with a single-select one.
    allowFreeformInput: true,
  })
}

/** The question body: the prompt itself when the header took the title, plus any detail. */
function buildMessage(item: AskUserQuestionItem): vscode.MarkdownString | undefined {
  const parts: string[] = []
  if (item.header !== undefined && item.header !== '') parts.push(item.question)
  if (item.detail !== undefined && item.detail !== '') parts.push(item.detail)
  if (parts.length === 0) return undefined
  // dsh renders detail as GitHub-flavoured markdown, so this side must too.
  return new vscode.MarkdownString(parts.join('\n\n'))
}

function recommendedOptionId(
  item: AskUserQuestionItem,
  options: { id: string; label: string; value: string }[] | undefined,
): string | undefined {
  if (options === undefined) return undefined
  const recommended = options.find(option => /\(recommended\)/i.test(option.label))
  if (recommended !== undefined) return recommended.id
  // A plan review names the approving option outright, which is a stronger
  // signal than a label convention.
  const approve = item.intent?.approve
  if (approve === undefined) return undefined
  return options.find(option => option.value === approve)?.id
}

/**
 * Reads one question's slot out of a carousel result.
 *
 * The shape the editor returns per question is not pinned by the proposal —
 * a bare string, an array, or an object with the free-form text alongside the
 * selection are all plausible — so this accepts all of them and normalises to
 * dsh's `{ selected, custom }`.
 */
function readAnswer(item: AskUserQuestionItem, raw: unknown): AskUserQuestionAnswerItem {
  const labels = new Set(item.options?.map(option => option.label) ?? [])
  const selected: string[] = []
  let custom: string | undefined

  const consider = (value: unknown): void => {
    if (typeof value !== 'string' || value === '') return
    if (labels.has(value)) selected.push(value)
    else custom = custom === undefined ? value : `${custom}\n${value}`
  }

  if (Array.isArray(raw)) for (const entry of raw) consider(entry)
  else if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>
    const values = record.values ?? record.selected ?? record.value
    if (Array.isArray(values)) for (const entry of values) consider(entry)
    else consider(values)
    consider(record.custom ?? record.text ?? record.freeform)
  } else {
    consider(raw)
  }

  // dsh rejects a single-select answer carrying both a selection and custom
  // text; the selection is the one the agent can act on.
  if (item.multiSelect !== true && selected.length > 0) custom = undefined
  if (item.multiSelect !== true && selected.length > 1) selected.splice(1)

  return custom === undefined ? { id: item.id, selected } : { id: item.id, selected, custom }
}

/**
 * Asks a whole `ask()` batch and returns dsh-shaped answers, or undefined when
 * the user dismissed the carousel.
 */
export async function askQuestions(
  stream: vscode.ChatResponseStream,
  items: AskUserQuestionItem[],
): Promise<Answers | undefined> {
  const questions = items.map(toChatQuestion)
  const result = await stream.questionCarousel(questions, true)
  if (result === undefined) return undefined
  // "Skip this question" is an empty selection, which dsh accepts as an
  // answered-but-empty item rather than as a cancellation.
  return items.map(item => readAnswer(item, result[item.id]))
}

/** Sends a question batch's answers back, echoing the frame's rpcId. */
export async function respondToQuestions(
  client: DshApiClient,
  rpcId: RpcId,
  sessionId: SessionId,
  answers: Answers | undefined,
): Promise<void> {
  const result = answers === undefined
    ? { ok: false as const, error: { code: 'cancelled', message: 'The user dismissed the question.' } }
    : { ok: true as const, value: { sessionId, answer: { answers } } }
  await client.respond(rpcId, result)
}

/** The two outcomes a client is allowed to give for an approval. */
export type ApprovalOutcome = 'allowed-once' | 'rejected'

/**
 * Asks for one tool approval.
 *
 * Modelled as a question rather than a confirmation for the blocking reason
 * above. The wording names the tool, because "allow this?" without a subject is
 * the approval prompt everyone learns to click through.
 */
export async function askApproval(
  stream: vscode.ChatResponseStream,
  toolName: string,
  reason: string | undefined,
): Promise<ApprovalOutcome | undefined> {
  const allow = 'Allow once'
  const reject = 'Reject'
  const question = new vscode.ChatQuestion(
    'approval',
    vscode.ChatQuestionType.SingleSelect,
    `Allow ${toolName}?`,
    {
      message: reason === undefined || reason === '' ? undefined : new vscode.MarkdownString(reason),
      options: [
        { id: 'allow', label: allow, value: allow },
        { id: 'reject', label: reject, value: reject },
      ],
    },
  )
  const result = await stream.questionCarousel([question], false)
  if (result === undefined) return undefined
  const answer = result.approval
  const text = Array.isArray(answer) ? answer[0] : answer
  if (typeof text !== 'string') return undefined
  return text === allow ? 'allowed-once' : 'rejected'
}

/** Sends an approval decision back, echoing the frame's rpcId. */
export async function respondToApproval(
  client: DshApiClient,
  rpcId: RpcId,
  sessionId: SessionId,
  approvalId: string,
  outcome: ApprovalOutcome | undefined,
): Promise<void> {
  const result = outcome === undefined
    ? { ok: false as const, error: { code: 'cancelled', message: 'The user dismissed the approval.' } }
    : { ok: true as const, value: { sessionId, approvalId, outcome } }
  await client.respond(rpcId, result)
}
