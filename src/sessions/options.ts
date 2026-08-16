import * as vscode from 'vscode'
import type { DshApiClient } from '../dsh/client'
import type { Log } from '../log'
import type {
  AgentPresetEntry, AgentPresetRoster, ModelProviderGroup, ModelSelection, SessionId, SessionModels,
} from '../dsh/wire'
import type { PermissionSelect } from './projections'

/** The option group ids this extension owns. */
export const MODEL_GROUP = 'model'
export const EFFORT_GROUP = 'reasoningEffort'
export const PERMISSION_GROUP = 'permissions'
export const PRESET_GROUP = 'agentPreset'

/**
 * Each chip's icon, carried by every *item*: the renderer shows the selected
 * item's icon before the chip label and on each dropdown row, and ignores a
 * group-level icon entirely. ThemeIcons only — the same constraint as the
 * harness picker (docs/gaps.md §21) — so the custom marks come from the
 * contributed icon font (media/dsh-icons.ttf).
 */
const MODEL_ICON = new vscode.ThemeIcon('deepseek-whale')
const EFFORT_ICON = new vscode.ThemeIcon('zap')

/**
 * dsh's own permission glyphs (design set 1556), exactly as its web composer
 * maps them: shield+check for read-only, shield+pencil for workspace-write,
 * shield+exclamation for full access. dsh keys the art on these exact preset
 * values with no glyph for anything else, and this mirrors that — a preset
 * outside the set gets the plain shield rather than a guessed meaning.
 */
const PERMISSION_ICONS: Record<string, vscode.ThemeIcon> = {
  'read-only': new vscode.ThemeIcon('deepseek-perm-read'),
  'workspace-write': new vscode.ThemeIcon('deepseek-perm-write'),
  'danger-full-access': new vscode.ThemeIcon('deepseek-perm-full'),
}
const PERMISSION_FALLBACK = new vscode.ThemeIcon('shield')

/** The chip icon for the agent-preset (pattern) picker: a stacked composition. */
const PRESET_ICON = new vscode.ThemeIcon('layers')

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

/** Builds every group for one session: the preset leads, then permissions, model and effort. */
export function buildGroups(
  models: SessionModels,
  permissions?: PermissionSelect,
  preset?: PresetSelect,
): vscode.ChatSessionProviderOptionGroup[] {
  const groups: vscode.ChatSessionProviderOptionGroup[] = []
  const presetGroup_ = presetGroup(preset)
  if (presetGroup_ !== undefined) groups.push(presetGroup_)
  const permission = permissionGroup(permissions)
  if (permission !== undefined) groups.push(permission)
  groups.push(modelGroup(models))
  const efforts = effortGroup(models)
  if (efforts !== undefined) groups.push(efforts)
  return groups
}

/**
 * The session's permission preset, as a picker of its own.
 *
 * `kind: 'permissions'` would be the right home — the editor folds such a
 * group into its own permission control — but that control is unreachable
 * here: its action is gated on
 * `or(lockedToCodingAgent.negate(), lockedCodingAgentId == Background)`, and a
 * composer locked to a third-party agent satisfies neither. Declaring the kind
 * therefore hides the group and offers nothing in its place, so this is a
 * standalone picker instead. See docs/gaps.md §11.
 *
 * dsh owns the list: presets, names and descriptions come from the
 * `permissions` projection, which folds the three knob events over the
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
    icon: PERMISSION_ICONS[option.value] ?? PERMISSION_FALLBACK,
  }))
  const selected = items.find(item => item.id === permissions.currentValue)
  return { id: PERMISSION_GROUP, name: 'Permissions', items, selected }
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

/**
 * The groups for a chat with no session yet.
 *
 * The model group carries no selection, because nothing advertises which model
 * a session that does not exist will start on — a guess here would show the
 * user one model and run another. The permission group does carry one: the
 * `permission` namespace states the default a new session starts with.
 */
export function buildBlankGroups(
  catalog: ModelProviderGroup[] | undefined,
  permissions: PermissionSelect | undefined,
  preset: PresetSelect | undefined,
  chosen: BlankChoices = {},
): vscode.ChatSessionProviderOptionGroup[] {
  const groups: vscode.ChatSessionProviderOptionGroup[] = []
  // The user's pick outranks the host's default: on a blank chat there is no
  // session to confirm it against, so this record *is* the current value until
  // one exists. Rebuilding from the default is what made every selection snap
  // back the instant it was made.
  const shownPreset = preset === undefined || chosen.agentPreset === undefined
    ? preset
    : { ...preset, currentValue: chosen.agentPreset }
  const presetG = presetGroup(shownPreset)
  if (presetG !== undefined) groups.push(presetG)

  const shown = permissions === undefined || chosen.preset === undefined
    ? permissions
    : { ...permissions, currentValue: chosen.preset }
  const permission = permissionGroup(shown)
  if (permission !== undefined) groups.push(permission)
  if (catalog !== undefined && catalog.length > 0) {
    const items = catalog.flatMap(provider => provider.models.map(model => ({
      id: modelOptionId(provider.id, model.id),
      name: model.name,
      description: describeModel(provider.name, model.description),
      icon: MODEL_ICON,
    })))
    const selected = items.find(item => item.id === chosen.model)
    groups.push({ id: MODEL_GROUP, name: 'Model', items, selected })

    const efforts = effortsOfCatalog(catalog, chosen.model, chosen.effort)
    if (efforts !== undefined) groups.push(efforts)
  }
  return groups
}

/** What a blank composer has been set to, before a session exists to hold it. */
export interface BlankChoices {
  model?: string
  effort?: string
  /** The permission preset. */
  preset?: string
  /** The agent preset (pattern). */
  agentPreset?: string
}

/**
 * Reads the current selection of every group this extension owns, as plain
 * ids. Blank composers and live sessions both expose their selections this
 * way, so the apply path below takes one shape for both.
 */
export function selectionsFromGroups(
  groups: readonly vscode.ChatSessionProviderOptionGroup[],
): BlankChoices {
  return {
    model: groups.find(group => group.id === MODEL_GROUP)?.selected?.id,
    effort: groups.find(group => group.id === EFFORT_GROUP)?.selected?.id,
    preset: groups.find(group => group.id === PERMISSION_GROUP)?.selected?.id,
    agentPreset: groups.find(group => group.id === PRESET_GROUP)?.selected?.id,
  }
}

/**
 * Applies choices the user made before a session existed (or while it was
 * still blank) to the session that now holds them.
 *
 * The model is applied only when a route was actually chosen — a blank
 * composer offers the model picker unselected, and sending nothing lets dsh
 * keep its default. The permission preset and agent preset apply only when a
 * value is present; callers that pass `agentPreset` straight to
 * `session.create` omit it here, while a reused blank session has no create
 * to carry it and switches with `agentPreset.select` instead.
 */
export async function applySelections(
  client: DshApiClient,
  sessionId: SessionId,
  selections: BlankChoices,
  log: Log,
): Promise<void> {
  if (selections.model !== undefined) {
    const cut = selections.model.indexOf('/')
    if (cut > 0) {
      const result = await client.call('session.selectModel', {
        sessionId,
        provider: selections.model.slice(0, cut),
        model: selections.model.slice(cut + 1),
        reasoningEffort: selections.effort,
      })
      if (!result.ok) log.error(`could not apply the chosen model: ${result.error.message}`)
      else log.info(`new session ${sessionId} set to ${selections.model}`)
    }
  }

  if (selections.preset !== undefined) {
    const result = await client.remote('commands/execute', {
      agentId: sessionId,
      line: `/permission ${selections.preset}`,
    })
    if (!result.ok) log.error(`could not apply the chosen preset: ${result.error.message}`)
    else log.info(`new session ${sessionId} set to ${selections.preset}`)
  }

  if (selections.agentPreset !== undefined) {
    const result = await client.call('agentPreset.select', {
      sessionId,
      agentPreset: selections.agentPreset,
    })
    if (!result.ok) log.error(`could not apply the chosen agent preset: ${result.error.message}`)
    else log.info(`new session ${sessionId} set to agent preset ${selections.agentPreset}`)
  }
}

/** The chosen model's efforts, straight from the host catalog. */
function effortsOfCatalog(
  catalog: ModelProviderGroup[],
  chosenModelId: string | undefined,
  chosenEffort: string | undefined,
): vscode.ChatSessionProviderOptionGroup | undefined {
  const route = chosenModelId === undefined ? undefined : parseModelOptionId(chosenModelId)
  if (route === undefined) return undefined
  const model = catalog.find(group => group.id === route.provider)?.models.find(entry => entry.id === route.model)
  const reasoning = model?.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return undefined
  const items = reasoning.efforts.map(effort => ({
    id: effort.id,
    name: effort.name,
    description: effort.description,
    icon: EFFORT_ICON,
  }))
  const activeId = chosenEffort ?? reasoning.defaultEffort
  return {
    id: EFFORT_GROUP,
    name: 'Reasoning',
    items,
    selected: items.find(item => item.id === activeId),
  }
}

/**
 * Whether two group sets would render identically.
 *
 * This is what keeps a picker from looping. `ChatSessionInputState`'s setter is
 * `set groups(t) { this.#e = t; this.#t?.() }` — no equality check — and the
 * notification reaches the workbench, which sets the groups back and fires
 * `onDidChange` again. Assigning unconditionally from inside that handler is an
 * unbounded round trip; it pins a CPU core and takes the extension host down
 * after a few clicks.
 */
export function sameGroups(
  left: readonly vscode.ChatSessionProviderOptionGroup[],
  right: readonly vscode.ChatSessionProviderOptionGroup[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((group, index) => {
    const other = right[index]
    if (other === undefined) return false
    if (group.id !== other.id || group.selected?.id !== other.selected?.id) return false
    if (group.items.length !== other.items.length) return false
    return group.items.every((item, at) => item.id === other.items[at]?.id)
  })
}

/**
 * The agent presets a composer can offer, as one picker group.
 *
 * Shaped like {@link PermissionSelect} so a blank composer and a live session
 * build their picker from one function. `currentValue` is the resolved preset
 * the session runs. The group is only offered while a session is still blank —
 * once a turn has run, dsh refuses to recompose it (`agent-preset-locked`), so
 * the caller omits the group entirely rather than locking it.
 */
export interface PresetSelect {
  /** Roster entries that can compose a session — broken presets already filtered out. */
  options: AgentPresetEntry[]
  currentValue: string | undefined
}

/**
 * Turns the roster into the picker's shape, dropping broken presets.
 *
 * Broken presets stay listed in dsh's roster because their directories still
 * occupy the id, but offering one for selection would only defer the failure to
 * a rejected session start.
 */
export function presetSelectOf(
  roster: AgentPresetRoster | undefined,
  currentValue: string | undefined,
): PresetSelect | undefined {
  if (roster === undefined) return undefined
  const options = roster.presets.filter(preset => preset.broken === undefined)
  if (options.length === 0) return undefined
  return { options, currentValue }
}

/**
 * English display names for the presets dsh ships, used while dsh's roster
 * publishes their localized `preset.yml` names. Custom presets keep their own
 * published name (or fall back to the id). Keys are the built-in preset ids.
 */
const BUILT_IN_PRESET_NAMES: Readonly<Record<string, string>> = {
  standard: 'Standard',
  code: 'PTC',
  minimal: 'Minimal',
  cordis: 'Creator',
}

/** The display name for one roster entry, with no description on the row. */
function presetName(preset: AgentPresetEntry): string {
  return BUILT_IN_PRESET_NAMES[preset.id] ?? preset.name ?? preset.id
}

/**
 * The agent-preset picker, mirroring the roster dsh advertises right now.
 *
 * Rows are name-only: descriptions are omitted so the dropdown stays short.
 * A preset authored in Creator mode or installed by a plugin shows up here
 * under the name it published (its id when it published none), so nothing is
 * hardcoded beyond the English labels for the four shipped presets.
 */
function presetGroup(select: PresetSelect | undefined): vscode.ChatSessionProviderOptionGroup | undefined {
  if (select === undefined || select.options.length === 0) return undefined
  const items: vscode.ChatSessionProviderOptionItem[] = select.options.map(preset => ({
    id: preset.id,
    name: presetName(preset),
    icon: PRESET_ICON,
  }))
  let selected = select.currentValue === undefined ? undefined : items.find(item => item.id === select.currentValue)
  if (selected === undefined && select.currentValue !== undefined) {
    // The session runs a preset the roster no longer advertises (deleted after
    // it started). Shown as-is so the picker tells the truth, but it is the
    // resolved value and cannot be re-selected.
    selected = { id: select.currentValue, name: select.currentValue, icon: PRESET_ICON }
    items.unshift(selected)
  }
  return { id: PRESET_GROUP, name: 'Pattern', items, selected }
}

/**
 * Switches the session's agent preset.
 *
 * Only blank sessions may switch — dsh answers `agent-preset-locked` once a
 * turn has run, because the conversation's history was produced under the old
 * preset's tools. The picker is only offered on a blank session, so this is
 * normally the creation-time switch; the guard stays because the blank status
 * can race the first prompt.
 */
export async function applyPreset(
  client: DshApiClient,
  sessionId: SessionId,
  current: string | undefined,
  groups: readonly vscode.ChatSessionProviderOptionGroup[],
  log: Log,
): Promise<string | undefined> {
  const chosen = groups.find(group => group.id === PRESET_GROUP)?.selected?.id
  if (chosen === undefined || chosen === current) return undefined

  const result = await client.call('agentPreset.select', { sessionId, agentPreset: chosen })
  if (!result.ok) {
    log.error(`agentPreset.select to ${chosen} failed: ${result.error.code}: ${result.error.message}`)
    void vscode.window.showErrorMessage(`Could not switch the agent preset: ${result.error.message}`)
    return undefined
  }
  log.info(`agent preset set to ${chosen}`)
  return result.value.agentPreset
}

function modelGroup(models: SessionModels): vscode.ChatSessionProviderOptionGroup {
  const items: vscode.ChatSessionProviderOptionItem[] = []
  for (const provider of models.groups) {
    for (const model of provider.models) {
      items.push({
        id: modelOptionId(provider.id, model.id),
        name: model.name,
        description: describeModel(provider.name, model.description),
        icon: MODEL_ICON,
      })
    }
  }

  const currentId = modelOptionId(models.current.provider, models.current.model)
  let selected = items.find(item => item.id === currentId)
  if (selected === undefined) {
    // A route can serve a model it has stopped advertising, so the current
    // selection may be absent from the catalog and is still perfectly usable.
    // Dropping it would silently show the wrong model in the header.
    selected = { id: currentId, name: models.current.model, description: models.current.provider, icon: MODEL_ICON }
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
    icon: EFFORT_ICON,
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
