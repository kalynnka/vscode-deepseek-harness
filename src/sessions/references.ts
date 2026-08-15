import * as vscode from 'vscode'
import { relative, isAbsolute } from 'node:path'
import type { Log } from '../log'
import type { PromptContentPart } from '../dsh/wire'

/**
 * Turns a chat request into dsh prompt content, attachments included.
 *
 * The editor mounts context the user never types: the pinned chip for the
 * active selection, files dropped on the composer, `#`-references, pasted
 * images. All of it arrives in `ChatRequest.references` and none of it is in
 * `request.prompt` — so a handler that sends only the prompt drops every
 * attachment silently, which is exactly what it looks like from the other end:
 * the editor shows a chip, and the agent has never heard of the file.
 *
 * dsh's prompt content is `text` or `image` and nothing else (see
 * docs/gaps.md §10), so a reference has to be *rendered* rather than passed
 * through as a structured attachment.
 */

/** Media types dsh's attachment plane accepts; anything else cannot be sent. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * How much attached text is inlined per reference.
 *
 * Selections are normally a few lines, but "select all" is one keystroke away
 * and the whole thing would go into the context window uncounted.
 */
const MAX_INLINE_CHARS = 8000

/** What one reference contributed: a block of prose, an image, or nothing. */
interface Rendered {
  text?: string
  image?: PromptContentPart
}

/** The envelope the rendered attachments are sent in. */
const ENVELOPE = 'editor-context'

/**
 * Removes a trailing attachment envelope, leaving the prompt as it was typed.
 *
 * The inverse of what {@link promptContentFor} appends, and deliberately next
 * to it: the two only stay in step if they are read together. It matches only
 * an envelope that closes the text, opened by the *last* opening tag before
 * that close — so a `<editor-context>` the user typed in the prompt itself
 * cannot start the cut and lose everything they wrote after it.
 */
export function stripEditorContext(text: string): string {
  const close = `\n</${ENVELOPE}>`
  const end = text.trimEnd()
  if (!end.endsWith(close)) return text
  const start = end.lastIndexOf(`<${ENVELOPE}>\n`, end.length - close.length)
  if (start === -1) return text
  return text.slice(0, start).trimEnd()
}

/**
 * Builds the content parts for one request.
 *
 * `cwd` is the session's own working directory as dsh reported it — paths are
 * shown relative to it so they mean the same thing to the agent's tools as
 * they do in the editor. When it is unknown, absolute paths are used rather
 * than paths relative to a directory the agent may not be in.
 */
export async function promptContentFor(
  request: vscode.ChatRequest,
  cwd: string | undefined,
  log: Log,
): Promise<PromptContentPart[]> {
  const references = request.references
  const blocks: string[] = []
  const images: PromptContentPart[] = []

  if (references.length > 0) {
    log.info(`request carries ${String(references.length)} reference(s): ${references.map(r => r.id).join(', ')}`)
  }

  for (const reference of references) {
    try {
      const rendered = await renderReference(reference, cwd)
      if (rendered.text !== undefined) blocks.push(rendered.text)
      if (rendered.image !== undefined) images.push(rendered.image)
      if (rendered.text === undefined && rendered.image === undefined) {
        log.warn(`reference ${reference.id} has no rendering; dropped`)
      }
    } catch (error) {
      // One unreadable attachment must not cost the user their prompt.
      log.error(`reference ${reference.id} could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const text = [
    request.prompt.trim(),
    blocks.length === 0 ? '' : `<${ENVELOPE}>\n${blocks.join('\n\n')}\n</${ENVELOPE}>`,
  ].filter(part => part !== '').join('\n\n')

  const parts: PromptContentPart[] = []
  // A prompt of nothing but a pasted image is a real thing to send.
  if (text !== '') parts.push({ type: 'text', text })
  parts.push(...images)
  return parts
}

async function renderReference(
  reference: vscode.ChatPromptReference,
  cwd: string | undefined,
): Promise<Rendered> {
  const value: unknown = reference.value

  // A selection: the one attachment whose content the agent cannot go and read
  // for itself, because the range is editor state rather than anything on disk.
  if (value instanceof vscode.Location) {
    const document = await vscode.workspace.openTextDocument(value.uri)
    const body = clamp(document.getText(value.range))
    const start = value.range.start.line + 1
    const end = value.range.end.line + 1
    const where = start === end ? `line ${String(start)}` : `lines ${String(start)}-${String(end)}`
    const fence = document.languageId
    return { text: `Selected in ${display(value.uri, cwd)}, ${where}:\n\`\`\`${fence}\n${body}\n\`\`\`` }
  }

  if (value instanceof vscode.Uri) {
    // An unsaved buffer has no path to read, so its content has to travel with
    // the prompt or the agent gets a name for a file that does not exist.
    if (value.scheme === 'untitled') {
      const document = await vscode.workspace.openTextDocument(value)
      return { text: `Unsaved editor ${display(value, cwd)}:\n\`\`\`${document.languageId}\n${clamp(document.getText())}\n\`\`\`` }
    }
    // A saved file is named, not inlined: dsh runs in this workspace with its
    // own read tools, and inlining would spend the context window on a file it
    // may not need to open.
    return { text: `Attached: ${display(value, cwd)}` }
  }

  // Pasted or dropped image data. The type is not in the proposals this
  // extension vendors, so it is matched on shape rather than with `instanceof`.
  const binary = asBinaryData(value)
  if (binary !== undefined) {
    if (!IMAGE_TYPES.has(binary.mimeType)) {
      return { text: `Attached ${binary.mimeType} data, which dsh cannot accept.` }
    }
    const bytes = await binary.data()
    return {
      image: {
        type: 'image',
        mediaType: binary.mimeType,
        // dsh rejects non-canonical base64, which is what Buffer produces.
        data: Buffer.from(bytes).toString('base64'),
        name: reference.name,
      },
    }
  }

  if (typeof value === 'string') {
    return { text: `${reference.name}:\n${clamp(value)}` }
  }

  // Anything else — a diagnostic set, a future reference kind — at least has a
  // description written for a model to read.
  if (reference.modelDescription !== undefined && reference.modelDescription !== '') {
    return { text: `${reference.name}: ${reference.modelDescription}` }
  }
  return {}
}

/** The `ChatReferenceBinaryData` shape, recognised without its type. */
function asBinaryData(value: unknown): { mimeType: string; data: () => Thenable<Uint8Array> } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { mimeType?: unknown; data?: unknown }
  if (typeof candidate.mimeType !== 'string' || typeof candidate.data !== 'function') return undefined
  return value as { mimeType: string; data: () => Thenable<Uint8Array> }
}

/**
 * How a resource is named to the agent.
 *
 * Relative to the session's cwd when it is inside it, because that is the path
 * the agent's own tools take; absolute otherwise, because a relative path that
 * escapes the session's directory is worse than no shortening at all.
 */
function display(uri: vscode.Uri, cwd: string | undefined): string {
  if (uri.scheme !== 'file') return uri.toString()
  if (cwd === undefined) return uri.fsPath
  const rel = relative(cwd, uri.fsPath)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? uri.fsPath : rel
}

function clamp(text: string): string {
  return text.length <= MAX_INLINE_CHARS
    ? text
    : `${text.slice(0, MAX_INLINE_CHARS)}\n…(${String(text.length - MAX_INLINE_CHARS)} more characters not attached)`
}
