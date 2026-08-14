import * as vscode from 'vscode'
import type { DshApiClient } from '../dsh/client'
import type { Log } from '../log'
import type { ModelSelection, SessionId, SessionModels } from '../dsh/wire'
import type { PermissionSelect } from './projections'

/** The option group ids this extension owns. */
export const MODEL_GROUP = 'model'
export const EFFORT_GROUP = 'reasoningEffort'
export const PERMISSION_GROUP = 'permissions'

/**
 * The session header's pickers, built from whatever dsh advertises right now.
 *
 * Nothing here is a list of DeepSeek's models: providers, model ids, display
 * names, the reasoning efforts each exact route offers and which one is its
 * default all come from `session.models` on every read. A deployment that adds
 * a provider, or a model that gains a new effort level, shows up without a
 * change here.
 *
 * The editor accepts at most two *standalone* pickers, which is exactly the
 * budget for model and reasoning effort. Agent presets therefore live on a
 * command rather than in the header — see docs/gaps.md §6. The permission
 * group is not a standalone picker: `kind: 'permissions'` puts its items into
 * the editor's own permission control, so it costs nothing from that budget.
 */

/** An option id encodes the full route, because a model id alone is ambiguous across providers. */
function modelOptionId(provider: string, model: string): string {
  return `${provider}/${model}`
}

function parseModelOptionId(id: string): { provider: string; model: string } | undefined {
  const cut = id.indexOf('/')
  if (cut <= 0) return undefined
  return { provider: id.slice(0, cut), model: id.slice(cut + 1) }
}

/** Builds every group for one session: model, reasoning effort, permissions. */
export function buildGroups(
  models: SessionModels,
  permissions?: PermissionSelect,
): vscode.ChatSessionProviderOptionGroup[] {
  const groups: vscode.ChatSessionProviderOptionGroup[] = [modelGroup(models)]
  const efforts = effortGroup(models)
  if (efforts !== undefined) groups.push(efforts)
  const permission = permissionGroup(permissions)
  if (permission !== undefined) groups.push(permission)
  return groups
}

/**
 * The session's permission preset, in the editor's own permission control.
 *
 * dsh owns this list: presets, their names and their descriptions come from
 * the `permissions` projection, which folds the three knob events over the
 * deployment's preset table. `custom` appears there only while the knobs match
 * no preset, and it is a state rather than a target — dsh advertises it as an
 * option all the same, so it is passed through and simply fails the switch if
 * anyone picks it.
 */
function permissionGroup(
  permissions: PermissionSelect | undefined,
): vscode.ChatSessionProviderOptionGroup | undefined {
  if (permissions === undefined) return undefined
  const items = permissions.options.map(option => ({
    id: option.value,
    name: option.name,
    description: option.description,
  }))
  const selected = items.find(item => item.id === permissions.currentValue)
  return { id: PERMISSION_GROUP, name: 'Permissions', kind: 'permissions', items, selected }
}

/**
 * Switches the session's permission preset.
 *
 * There is no `permission.*` RPC, and a `/permission` line sent through
 * `session.prompt` is *not* intercepted — it reaches the model as an ordinary
 * prompt and costs a turn. The command registry lives on dsh's other RPC
 * plane, `commands/execute`, which is what dsh's own picker calls. See
 * docs/gaps.md §11.
 */
export async function applyPermission(
  client: DshApiClient,
  sessionId: SessionId,
  current: PermissionSelect,
  groups: readonly vscode.ChatSessionProviderOptionGroup[],
  log: Log,
): Promise<boolean> {
  const chosen = groups.find(group => group.id === PERMISSION_GROUP)?.selected?.id
  if (chosen === undefined || chosen === current.currentValue) return false

  const result = await client.remote('commands/execute', { agentId: sessionId, line: `/permission ${chosen}` })
  if (!result.ok) {
    log.error(`permission switch to ${chosen} failed: ${result.error.code}: ${result.error.message}`)
    void vscode.window.showErrorMessage(`Could not switch permissions: ${result.error.message}`)
    return false
  }
  if (result.value === undefined) {
    // No command matched: this dsh has no `/permission`. Falling back to a
    // prompt would spend a turn asking the model to change a setting it does
    // not own, so the switch simply fails and says so.
    log.error(`this dsh offers no /permission command; the preset is unchanged`)
    void vscode.window.showErrorMessage('This dsh build offers no /permission command.')
    return false
  }
  log.info(`permission preset set to ${chosen}: ${result.value.result?.text ?? 'no message'}`)
  return true
}

function modelGroup(models: SessionModels): vscode.ChatSessionProviderOptionGroup {
  const items: vscode.ChatSessionProviderOptionItem[] = []
  for (const provider of models.groups) {
    for (const model of provider.models) {
      items.push({
        id: modelOptionId(provider.id, model.id),
        name: model.name,
        description: describeModel(provider.name, model.description),
      })
    }
  }

  const currentId = modelOptionId(models.current.provider, models.current.model)
  let selected = items.find(item => item.id === currentId)
  if (selected === undefined) {
    // A route can serve a model it has stopped advertising, so the current
    // selection may be absent from the catalog and is still perfectly usable.
    // Dropping it would silently show the wrong model in the header.
    selected = { id: currentId, name: models.current.model, description: models.current.provider }
    items.unshift(selected)
  }

  return { id: MODEL_GROUP, name: 'Model', items, selected }
}

function describeModel(providerName: string, description: string | undefined): string {
  return description === undefined || description === '' ? providerName : `${providerName} — ${description}`
}

/**
 * The efforts of the *currently selected* model only.
 *
 * Reasoning effort is adapter-owned per exact model route, so there is no
 * global list to show; a session on a model with no reasoning metadata gets no
 * group at all rather than an empty one.
 */
function effortGroup(models: SessionModels): vscode.ChatSessionProviderOptionGroup | undefined {
  const provider = models.groups.find(group => group.id === models.current.provider)
  const model = provider?.models.find(entry => entry.id === models.current.model)
  const reasoning = model?.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return undefined

  const items = reasoning.efforts.map(effort => ({
    id: effort.id,
    name: effort.name,
    description: effort.description,
  }))
  const activeId = models.current.reasoningEffort ?? reasoning.defaultEffort
  const selected = items.find(item => item.id === activeId)

  return { id: EFFORT_GROUP, name: 'Reasoning', items, selected }
}

/**
 * Applies a picker change by re-selecting the whole route.
 *
 * `session.selectModel` takes a complete selection rather than a patch, so
 * changing only the effort still has to resend provider and model — and
 * changing the model has to drop an effort the new route may not offer.
 */
export async function applySelection(
  client: DshApiClient,
  sessionId: SessionId,
  models: SessionModels,
  groups: readonly vscode.ChatSessionProviderOptionGroup[],
  log: Log,
): Promise<ModelSelection | undefined> {
  const modelId = groups.find(group => group.id === MODEL_GROUP)?.selected?.id
  const route = modelId === undefined ? undefined : parseModelOptionId(modelId)
  const provider = route?.provider ?? models.current.provider
  const model = route?.model ?? models.current.model

  const changedModel = provider !== models.current.provider || model !== models.current.model
  const effortId = groups.find(group => group.id === EFFORT_GROUP)?.selected?.id
  // An effort belongs to an exact route; carrying the old one onto a new model
  // is how you get a rejected selection instead of a switched model.
  const reasoningEffort = changedModel ? undefined : effortId ?? models.current.reasoningEffort

  if (!changedModel && reasoningEffort === models.current.reasoningEffort) return undefined

  const result = await client.call('session.selectModel', { sessionId, provider, model, reasoningEffort })
  if (!result.ok) {
    log.error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    void vscode.window.showErrorMessage(`Could not switch model: ${result.error.message}`)
    return undefined
  }
  log.info(`model set to ${provider}/${model}${reasoningEffort === undefined ? '' : ` (${reasoningEffort})`}`)
  return result.value.selected
}
