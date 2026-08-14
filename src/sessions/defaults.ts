import type { DshApiClient } from '../dsh/client'
import type { Log } from '../log'
import type { ModelProviderGroup, SettingsNamespaceView } from '../dsh/wire'
import type { PermissionSelect } from './projections'

/**
 * What the composer can know before a session exists.
 *
 * The editor asks for the input state of a blank chat with `undefined` for the
 * resource, which means there is no session to read `session.models` or the
 * `permissions` projection from. Both answers still exist host-side: the model
 * catalog is `llm.models`, and the preset a new session will start with is the
 * `permission` namespace's `defaultPreset`.
 *
 * Nothing here is a fallback list. If a call fails or a namespace is absent,
 * the corresponding picker is simply not offered.
 */

/** Host-level catalogs for a chat that has no session yet. */
export interface BlankDefaults {
  models?: ModelProviderGroup[]
  permissions?: PermissionSelect
}

export async function readBlankDefaults(client: DshApiClient, log: Log): Promise<BlankDefaults> {
  const defaults: BlankDefaults = {}

  const catalog = await client.call('llm.models', {})
  if (catalog.ok) defaults.models = catalog.value.groups
  else log.info(`llm.models unavailable: ${catalog.error.code}`)

  const settings = await client.call('settings.describe', {})
  if (!settings.ok) {
    log.info(`settings.describe unavailable: ${settings.error.code}`)
    return defaults
  }
  const namespace = settings.value.namespaces.find(entry => entry.ns === 'permission')
  if (namespace === undefined) {
    // No permission service is composed on this host, so there is no preset to
    // show and no control to offer.
    log.info('this dsh composes no permission namespace')
    return defaults
  }
  const permissions = permissionDefaultOf(namespace)
  if (permissions !== undefined) defaults.permissions = permissions
  return defaults
}

/**
 * The default preset and the presets a new session may start with.
 *
 * Shaped as a {@link PermissionSelect} so the blank composer and a live
 * session build their picker from one function.
 */
export function permissionDefaultOf(view: SettingsNamespaceView): PermissionSelect | undefined {
  const current = (view.value as { defaultPreset?: unknown } | null | undefined)?.defaultPreset
  if (typeof current !== 'string') return undefined
  const choices = enumChoicesAt(view.schema, 'defaultPreset')
  if (choices === undefined || !choices.some(choice => choice.value === current)) return undefined
  return { options: choices, currentValue: current }
}

/**
 * Reads one field's allowed values out of a serialized schemastery schema.
 *
 * The envelope is `{ uid, refs }`: a graph of numbered nodes where `uid` names
 * the root. A field's node is reached through the root object's `dict`, and an
 * enum is a `union` whose `list` holds `const` nodes — each carrying the value
 * and, when configured, a description.
 *
 * A single-choice field is a bare `const` rather than a union, so that case is
 * read too; anything else is not an enum and yields nothing.
 */
export function enumChoicesAt(
  schema: unknown,
  field: string,
): { value: string; name: string; description?: string }[] | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const envelope = schema as { uid?: unknown; refs?: unknown }
  if (typeof envelope.refs !== 'object' || envelope.refs === null) return undefined
  const refs = envelope.refs as Record<string, Node>
  const node = (ref: unknown): Node | undefined =>
    typeof ref === 'number' || typeof ref === 'string' ? refs[String(ref)] : undefined

  const root = node(envelope.uid)
  const target = node(root?.dict?.[field])
  if (target === undefined) return undefined

  const nodes = target.type === 'union' ? (target.list ?? []).map(node) : [target]
  const choices = nodes.flatMap(candidate => {
    if (candidate?.type !== 'const' || typeof candidate.value !== 'string') return []
    const described = candidate.meta?.description
    return [{
      value: candidate.value,
      name: candidate.value,
      ...(typeof described === 'string' && described !== '' ? { description: described } : {}),
    }]
  })
  return choices.length === 0 ? undefined : choices
}

interface Node {
  type?: string
  value?: unknown
  list?: unknown[]
  dict?: Record<string, unknown>
  meta?: { description?: unknown }
}
