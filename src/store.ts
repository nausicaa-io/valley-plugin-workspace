/**
 * The Workspace plugin's data layer — Obsidian-style named layouts.
 *
 * A `WorkspaceStore` owns the saved-layout list in plugin-owned relational
 * datasets and the
 * active-layout name (the `ACTIVE` badge, persisted via `api.settings`). It is
 * anchored in session-scoped `api.runtime`, so a mid-session hot reload replaces
 * rather than strands the in-memory list. The panel subscribes; commands mutate through the
 * same primitives, so both surfaces stay in sync.
 *
 * Groups come from two places and `groups()` merges them: every layout's `group`
 * field and the explicit rows in `workspace.workspace_groups`. That is what lets
 * an empty group exist before a layout is saved into it.
 */
import {
  WORKSPACE_VIEW_STATE_V1,
  type InteropExtensionProvider,
  type ValleyPluginApi,
  type WorkspaceViewStateProvider
} from '@valley/plugin-sdk'
import type {
  WorkspaceLayoutSnapshot,
  WorkspaceNode,
  WorkspacePluginViewState,
  WorkspaceViewStateValue,
  WorkspaceViewSurface
} from '@valley/plugin-sdk/types'
import type { DatasetRecord } from '@valley/plugin-sdk'
import { api as runtimeApi, initRuntime } from './runtime'

export interface SavedLayout {
  name: string
  /** Optional group label; empty string means ungrouped. */
  group: string
  snapshot: WorkspaceLayoutSnapshot
  createdAt: number
  modifiedAt: number
}

const STORE_KEY = 'workspace.store'
const ACTIVE_SETTING = 'active'
const ICON_RAIL_SETTING = 'saveIconRail'
const FOOTER_RAIL_SETTING = 'saveFooterRail'
const RIGHT_SIDEBAR_SETTING = 'saveRightSidebarState'
const GROUPS_DATASET = 'workspace_groups'
const LAYOUTS_DATASET = 'workspace_layouts'
/**
 * A key for "has the live arrangement diverged from what's saved" comparisons —
 * includes the complete captured snapshot, including the focused pane and active
 * tab. Switching to another open tab therefore makes the current layout different
 * until the saved layout is restored or saved again.
 */
export function structuralSnapshotKey(snapshot: WorkspaceLayoutSnapshot): string {
  try {
    return JSON.stringify(stableValue(storedSnapshot(snapshot)))
  } catch {
    return ''
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  )
}

function jsonState(value: unknown): WorkspaceViewStateValue | undefined {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return undefined
    return JSON.parse(encoded) as WorkspaceViewStateValue
  } catch {
    return undefined
  }
}

function normalizePluginViewStates(value: unknown): WorkspacePluginViewState[] | undefined {
  if (!Array.isArray(value)) return undefined
  const states = value.flatMap((entry): WorkspacePluginViewState[] => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Record<string, unknown>
    if (
      typeof raw.owner !== 'string' || !raw.owner ||
      typeof raw.id !== 'string' || !raw.id ||
      !['left_sidebar', 'right_sidebar', 'main_workspace'].includes(String(raw.surface))
    ) return []
    const state = jsonState(raw.state)
    if (state === undefined) return []
    return [{
      owner: raw.owner,
      id: raw.id,
      surface: raw.surface as WorkspaceViewSurface,
      state
    }]
  })
  states.sort((left, right) =>
    left.owner.localeCompare(right.owner) ||
    left.surface.localeCompare(right.surface) ||
    left.id.localeCompare(right.id)
  )
  return states.length > 0 ? states : undefined
}

/** Keep only recognized fields while preserving optional legacy/new scopes. */
function storedSnapshot(raw: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
  const pluginViewStates = normalizePluginViewStates(raw.pluginViewStates)
  return {
    layout: raw.layout,
    activePaneId: raw.activePaneId,
    leftSidebarWidth: raw.leftSidebarWidth,
    leftSidebarVisible: raw.leftSidebarVisible,
    ...(typeof raw.activePanel === 'string' ? { activePanel: raw.activePanel } : {}),
    ...(typeof raw.rightSidebarWidth === 'number' ? { rightSidebarWidth: raw.rightSidebarWidth } : {}),
    ...(typeof raw.rightSidebarVisible === 'boolean' ? { rightSidebarVisible: raw.rightSidebarVisible } : {}),
    ...(raw.rightSidebarLayout ? { rightSidebarLayout: raw.rightSidebarLayout } : {}),
    ...(typeof raw.railVisible === 'boolean' ? { railVisible: raw.railVisible } : {}),
    ...(Array.isArray(raw.panelOrder) ? { panelOrder: raw.panelOrder.filter((id): id is string => typeof id === 'string') } : {}),
    ...(Array.isArray(raw.hiddenPanelIds)
      ? { hiddenPanelIds: raw.hiddenPanelIds.filter((id): id is string => typeof id === 'string') }
      : {}),
    ...(typeof raw.footerVisible === 'boolean' ? { footerVisible: raw.footerVisible } : {}),
    ...(raw.footerLayout ? { footerLayout: raw.footerLayout } : {}),
    ...(pluginViewStates ? { pluginViewStates } : {})
  }
}

interface CaptureSettings {
  iconRail: boolean
  footerRail: boolean
  rightSidebar: boolean
}

const providerKey = (owner: string, provider: WorkspaceViewStateProvider): string =>
  `${owner}\u0000${provider.surface}\u0000${provider.id}`

const stateKey = (entry: WorkspacePluginViewState): string =>
  `${entry.owner}\u0000${entry.surface}\u0000${entry.id}`

function allTabs(node: WorkspaceNode): { kind?: string; pluginId?: string }[] {
  return node.type === 'leaf' ? node.tabs : node.children.flatMap(allTabs)
}

function ownerPresent(snapshot: WorkspaceLayoutSnapshot, surface: WorkspaceViewSurface, owner: string): boolean {
  if (surface === 'left_sidebar') return snapshot.activePanel === owner
  const node = surface === 'right_sidebar' ? snapshot.rightSidebarLayout : snapshot.layout
  if (!node) return false
  return allTabs(node).some((tab) => tab.pluginId === owner || tab.kind === owner)
}

export class WorkspaceStore {
  layouts: SavedLayout[] = []
  /** Groups created on their own; they stay listed while they hold no layout. */
  declaredGroups: string[] = []
  active: string | null = null
  private loaded = false
  private persistQueue: Promise<void> = Promise.resolve()
  private persistFailure: { reason: unknown } | null = null
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private providerCleanups: (() => void)[] = []

  constructor(private readonly api: ValleyPluginApi) {
    this.cleanups.push(api.runtime.onBeforeUnload(async () => {
      let pending: Promise<void>
      do { pending = this.persistQueue; await pending } while (pending !== this.persistQueue)
      if (this.persistFailure) throw this.persistFailure.reason
    }))
    this.cleanups.push(api.settings.subscribe(() => this.notify()))
    const refresh = (): void => { if (this.loaded) void this.refresh() }
    this.cleanups.push(api.data.dataset(GROUPS_DATASET).subscribe(refresh))
    this.cleanups.push(api.data.dataset(LAYOUTS_DATASET).subscribe(refresh))
    this.cleanups.push(api.interop.extensions.subscribe(WORKSPACE_VIEW_STATE_V1, () => {
      this.bindProviderSubscriptions()
      this.notify()
    }))
    this.bindProviderSubscriptions()
  }

  dispose(): void {
    this.providerCleanups.splice(0).forEach((off) => off())
    this.cleanups.splice(0).forEach((off) => off())
    this.listeners.clear()
  }

  private providers(): readonly InteropExtensionProvider<WorkspaceViewStateProvider>[] {
    return this.api.interop.extensions.providers(WORKSPACE_VIEW_STATE_V1)
  }

  private bindProviderSubscriptions(): void {
    this.providerCleanups.splice(0).forEach((off) => off())
    for (const provider of this.providers()) {
      try {
        this.providerCleanups.push(provider.extension.subscribe(() => this.notify()))
      } catch {
        // A broken provider never prevents the remaining workspace state from saving.
      }
    }
  }

  private captureSettings(): CaptureSettings {
    const settings = this.api.settings.get()
    return {
      iconRail: settings[ICON_RAIL_SETTING] === true,
      footerRail: settings[FOOTER_RAIL_SETTING] === true,
      rightSidebar: settings[RIGHT_SIDEBAR_SETTING] !== false
    }
  }

  private projectSnapshot(raw: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
    const snapshot = storedSnapshot(raw)
    const settings = this.captureSettings()
    const projected: WorkspaceLayoutSnapshot = {
      layout: snapshot.layout,
      activePaneId: snapshot.activePaneId,
      leftSidebarWidth: snapshot.leftSidebarWidth,
      leftSidebarVisible: snapshot.leftSidebarVisible,
      ...(snapshot.activePanel ? { activePanel: snapshot.activePanel } : {})
    }
    if (settings.rightSidebar) {
      if (snapshot.rightSidebarWidth != null) projected.rightSidebarWidth = snapshot.rightSidebarWidth
      if (snapshot.rightSidebarVisible != null) projected.rightSidebarVisible = snapshot.rightSidebarVisible
      if (snapshot.rightSidebarLayout) projected.rightSidebarLayout = snapshot.rightSidebarLayout
    }
    if (settings.iconRail) {
      if (snapshot.railVisible != null) projected.railVisible = snapshot.railVisible
      if (snapshot.panelOrder) projected.panelOrder = snapshot.panelOrder
      if (snapshot.hiddenPanelIds) projected.hiddenPanelIds = snapshot.hiddenPanelIds
    }
    if (settings.footerRail) {
      if (snapshot.footerVisible != null) projected.footerVisible = snapshot.footerVisible
      if (snapshot.footerLayout) projected.footerLayout = snapshot.footerLayout
    }
    const pluginViewStates = snapshot.pluginViewStates?.filter((entry) =>
      entry.surface !== 'right_sidebar' || settings.rightSidebar
    )
    if (pluginViewStates?.length) projected.pluginViewStates = pluginViewStates
    return projected
  }

  private captureProviderStates(snapshot: WorkspaceLayoutSnapshot): WorkspacePluginViewState[] {
    const settings = this.captureSettings()
    const states: WorkspacePluginViewState[] = []
    for (const provider of this.providers()) {
      const extension = provider.extension
      if (extension.surface === 'right_sidebar' && !settings.rightSidebar) continue
      if (!ownerPresent(snapshot, extension.surface, provider.owner)) continue
      try {
        const state = jsonState(extension.capture())
        if (state === undefined) continue
        states.push({
          owner: provider.owner,
          id: extension.id,
          surface: extension.surface,
          state
        })
      } catch {
        // Keep the host layout usable even when one provider cannot capture.
      }
    }
    return normalizePluginViewStates(states) ?? []
  }

  /** Load the persisted list + active name once (idempotent). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await this.refresh()
    this.loaded = true
  }

  /** Re-read the list from disk (e.g. another window mutated it). */
  async refresh(): Promise<void> {
    const [layouts, groups] = await Promise.all([
      this.readDataset(LAYOUTS_DATASET),
      this.readDataset(GROUPS_DATASET)
    ])
    this.layouts = layouts
      .map((r) => normalize(r))
      .filter((l): l is SavedLayout => l !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
    this.declaredGroups = dedupeGroups(groups
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((record) => asName(record.name)))
    const settingActive = this.api.settings.get()[ACTIVE_SETTING]
    this.active = typeof settingActive === 'string' && this.find(settingActive) ? settingActive : null
    this.notify()
  }

  find(name: string): SavedLayout | undefined {
    const key = name.trim().toLowerCase()
    return this.layouts.find((l) => l.name.toLowerCase() === key)
  }

  /**
   * Group → layouts, in a stable, case-insensitive order (ungrouped last).
   * Declared groups are listed even when empty; a layout whose group differs
   * only by case joins the declared one rather than heading a twin.
   */
  groups(): { group: string; layouts: SavedLayout[] }[] {
    const byGroup = new Map<string, SavedLayout[]>()
    const labels = new Map<string, string>()
    const bucket = (raw: string): string => {
      const key = raw.toLowerCase()
      if (!byGroup.has(key)) {
        byGroup.set(key, [])
        labels.set(key, raw)
      }
      return key
    }
    for (const declared of this.declaredGroups) if (declared) bucket(declared)
    for (const l of this.layouts) byGroup.get(bucket(l.group.trim()))?.push(l)
    return [...byGroup.entries()]
      .map(([key, layouts]) => ({ group: labels.get(key) ?? key, layouts }))
      .sort((a, b) => (a.group === '' ? 1 : b.group === '' ? -1 : a.group.localeCompare(b.group)))
  }

  /** Every group name that currently exists (declared or held by a layout). */
  groupNames(): string[] {
    return this.groups()
      .map((g) => g.group)
      .filter((g) => g !== '')
  }

  /** Does a group by this name exist already (case-insensitive)? */
  hasGroup(name: string): boolean {
    const key = name.trim().toLowerCase()
    return key !== '' && this.groupNames().some((g) => g.toLowerCase() === key)
  }

  /**
   * Create a group with no layouts in it — the panel's "New group". Throws on a
   * blank name or one that is already taken; returns the trimmed name.
   */
  async createGroup(name: string): Promise<string> {
    const next = name.trim()
    if (!next) throw new Error('A group name is required.')
    if (this.hasGroup(next)) throw new Error(`A group named "${next}" already exists.`)
    this.declaredGroups = [...this.declaredGroups, next]
    await this.persist()
    return next
  }

  /**
   * Drop a group: its declaration goes and every layout in it falls back to
   * ungrouped. Returns the names that moved, so a caller can register a revert.
   */
  async deleteGroup(name: string): Promise<string[]> {
    const key = name.trim().toLowerCase()
    if (!key) throw new Error('A group name is required.')
    if (!this.hasGroup(key)) throw new Error(`No group named "${name.trim()}".`)
    const members = this.layouts.filter((l) => l.group.trim().toLowerCase() === key).map((l) => l.name)
    this.declaredGroups = this.declaredGroups.filter((g) => g.trim().toLowerCase() !== key)
    this.layouts = this.layouts.map((l) => (l.group.trim().toLowerCase() === key ? { ...l, group: '' } : l))
    await this.persist()
    return members
  }

  /** Move several layouts into one group in a single persist (the group reverts). */
  async assignGroup(names: string[], group: string): Promise<void> {
    const keys = new Set(names.map((n) => n.trim().toLowerCase()))
    if (keys.size === 0) return
    this.layouts = this.layouts.map((l) => (keys.has(l.name.toLowerCase()) ? { ...l, group: group.trim() } : l))
    await this.persist()
  }

  /** Capture the live workspace arrangement. */
  capture(): WorkspaceLayoutSnapshot {
    const snapshot = this.projectSnapshot(this.api.workspace.captureLayout())
    const pluginViewStates = this.captureProviderStates(snapshot)
    return pluginViewStates.length > 0 ? { ...snapshot, pluginViewStates } : snapshot
  }

  /** Capture for persistence, retaining an unavailable provider's opaque state. */
  captureForSave(prior?: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
    const snapshot = this.capture()
    const current = new Map((snapshot.pluginViewStates ?? []).map((entry) => [stateKey(entry), entry]))
    for (const entry of this.projectSnapshot(prior ?? snapshot).pluginViewStates ?? []) {
      if (current.has(stateKey(entry))) continue
      if (!ownerPresent(snapshot, entry.surface, entry.owner)) continue
      current.set(stateKey(entry), entry)
    }
    const pluginViewStates = normalizePluginViewStates([...current.values()])
    return pluginViewStates ? { ...snapshot, pluginViewStates } : snapshot
  }

  isCurrent(snapshot: WorkspaceLayoutSnapshot): boolean {
    const live = this.capture()
    const available = new Set(this.providers().map((provider) => providerKey(provider.owner, provider.extension)))
    const saved = this.projectSnapshot(snapshot)
    const comparable: WorkspaceLayoutSnapshot = { ...live, ...saved }
    if (saved.pluginViewStates) {
      const states = new Map((live.pluginViewStates ?? []).map((entry) => [stateKey(entry), entry]))
      for (const entry of saved.pluginViewStates) {
        if (available.has(stateKey(entry))) states.set(stateKey(entry), entry)
      }
      const pluginViewStates = normalizePluginViewStates([...states.values()])
      if (pluginViewStates) comparable.pluginViewStates = pluginViewStates
      else delete comparable.pluginViewStates
    }
    return structuralSnapshotKey(live) === structuralSnapshotKey(comparable)
  }

  /** Restore an arrangement into the live workspace. */
  applySnapshot(snapshot: WorkspaceLayoutSnapshot): void {
    const projected = this.projectSnapshot(snapshot)
    this.api.workspace.applyLayout(projected)
    const saved = new Map((projected.pluginViewStates ?? []).map((entry) => [stateKey(entry), entry]))
    for (const provider of this.providers()) {
      const entry = saved.get(providerKey(provider.owner, provider.extension))
      if (!entry || !ownerPresent(projected, entry.surface, entry.owner)) continue
      try {
        provider.extension.restore(entry.state)
      } catch {
        // Provider restoration is isolated from the host layout and its peers.
      }
    }
  }

  /** Capture the live arrangement and save it under `name` (the panel's Save). */
  async saveCurrent(name: string, group = ''): Promise<SavedLayout> {
    const prior = this.find(name)
    const now = Date.now()
    const layout: SavedLayout = {
      name,
      group,
      snapshot: this.captureForSave(prior?.snapshot),
      createdAt: prior?.createdAt ?? now,
      modifiedAt: now
    }
    await this.upsert(layout)
    await this.setActive(name)
    return layout
  }

  /** Restore a saved layout into the live workspace (the panel's Load). */
  async loadByName(name: string): Promise<SavedLayout> {
    const target = this.find(name)
    if (!target) throw new Error(`No saved layout named "${name}".`)
    this.applySnapshot(target.snapshot)
    await this.setActive(target.name)
    return target
  }

  /** Insert or replace a layout by name, then persist + notify. */
  async upsert(layout: SavedLayout): Promise<void> {
    const next = this.layouts.filter((l) => l.name.toLowerCase() !== layout.name.toLowerCase())
    next.push(layout)
    next.sort((a, b) => a.name.localeCompare(b.name))
    this.layouts = next
    await this.persist()
  }

  /** Remove a layout by name (no-op if absent), then persist + notify. */
  async deleteByName(name: string): Promise<void> {
    const key = name.trim().toLowerCase()
    this.layouts = this.layouts.filter((l) => l.name.toLowerCase() !== key)
    if (this.active && this.active.toLowerCase() === key) await this.setActive(null)
    await this.persist()
  }

  /**
   * Rename a saved layout, preserving its group/createdAt/snapshot and moving the
   * `ACTIVE` pointer if it pointed at the old name. Throws if `oldName` is absent
   * or `newName` collides with a *different* existing layout. Returns the prior
   * entry so a caller can register a revert.
   */
  async renameByName(oldName: string, newName: string): Promise<SavedLayout> {
    const prior = this.find(oldName)
    if (!prior) throw new Error(`No saved layout named "${oldName}".`)
    const next = newName.trim()
    if (!next) throw new Error('A new name is required.')
    const clash = this.find(next)
    if (clash && clash.name.toLowerCase() !== prior.name.toLowerCase()) {
      throw new Error(`A layout named "${next}" already exists.`)
    }
    const renamed: SavedLayout = { ...prior, name: next, modifiedAt: Date.now() }
    const wasActive = this.active != null && this.active.toLowerCase() === prior.name.toLowerCase()
    this.layouts = this.layouts
      .filter((l) => l.name.toLowerCase() !== prior.name.toLowerCase())
      .concat(renamed)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (wasActive) await this.setActive(next)
    await this.persist()
    return prior
  }

  /** Move a saved layout into (or out of, with `''`) a group — the ⋯ menu's "Add to Group". */
  async setGroup(name: string, group: string): Promise<void> {
    const key = name.trim().toLowerCase()
    const idx = this.layouts.findIndex((l) => l.name.toLowerCase() === key)
    if (idx === -1) throw new Error(`No saved layout named "${name}".`)
    this.layouts[idx] = { ...this.layouts[idx], group: group.trim() }
    await this.persist()
  }

  /**
   * Rename a group, moving every layout currently in `oldGroup` to `newGroup`
   * in one batch (a single persist/notify, unlike calling `setGroup` per layout)
   * and carrying the declaration across so an empty group can be renamed too.
   * No-op if nothing carries the old name; throws if `newGroup` is blank.
   */
  async renameGroup(oldGroup: string, newGroup: string): Promise<void> {
    const from = oldGroup.trim().toLowerCase()
    const to = newGroup.trim()
    if (!to) throw new Error('A new group name is required.')
    if (from === to.toLowerCase()) return
    let changed = false
    this.layouts = this.layouts.map((l) => {
      if (l.group.trim().toLowerCase() !== from) return l
      changed = true
      return { ...l, group: to }
    })
    if (this.declaredGroups.some((g) => g.trim().toLowerCase() === from)) {
      this.declaredGroups = dedupeGroups(this.declaredGroups.map((g) => (g.trim().toLowerCase() === from ? to : g)))
      changed = true
    }
    if (!changed) return
    await this.persist()
  }

  async setActive(name: string | null): Promise<void> {
    this.active = name
    await this.api.settings.set(ACTIVE_SETTING, name ?? '')
    this.notify()
  }

  private async persist(): Promise<void> {
    const run = async (): Promise<void> => {
      const [oldLayouts, oldGroups] = await Promise.all([
        this.readDataset(LAYOUTS_DATASET),
        this.readDataset(GROUPS_DATASET)
      ])
      await this.api.data.transaction([
        ...oldLayouts.map((row) => ({
          dataset: LAYOUTS_DATASET, operation: 'delete' as const, key: { name: String(row.name) }
        })),
        ...oldGroups.map((row) => ({
          dataset: GROUPS_DATASET, operation: 'delete' as const, key: { name: String(row.name) }
        })),
        ...this.layouts.map((layout) => ({
          dataset: LAYOUTS_DATASET,
          operation: 'insert' as const,
          values: {
            name: layout.name,
            group: layout.group,
            snapshotVersion: 1,
            snapshot: layout.snapshot as unknown as DatasetRecord,
            createdAt: layout.createdAt,
            modifiedAt: layout.modifiedAt
          }
        })),
        ...this.declaredGroups.map((name, position) => ({
          dataset: GROUPS_DATASET, operation: 'insert' as const, values: { name, position }
        }))
      ])
      this.notify()
    }
    const next = this.persistQueue.then(run, run)
    this.persistQueue = next.then(
      () => { this.persistFailure = null },
      (reason) => { this.persistFailure = { reason } }
    )
    return next
  }

  private async readDataset(dataset: string): Promise<DatasetRecord[]> {
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.api.data.dataset(dataset).query({ limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor)
    return rows
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }
}

const asName = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Keep the first spelling of each group name, drop blanks and case-twins. */
function dedupeGroups(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = name.toLowerCase()
    if (!name || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalize(record: Record<string, unknown>): SavedLayout | null {
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const snapshot = record.snapshot
  if (!name || !snapshot || typeof snapshot !== 'object') return null
  const now = Date.now()
  return {
    name,
    group: typeof record.group === 'string' ? record.group : '',
    snapshot: storedSnapshot(snapshot as WorkspaceLayoutSnapshot),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    modifiedAt: typeof record.modifiedAt === 'number' ? record.modifiedAt : now
  }
}

/**
 * Replace the one session-scoped store with a fresh instance for the given
 * `api`. Called from `register()` on every (re)load — a hot reload drops the
 * previous instance rather than stranding open views on it.
 */
export function createStore(api: ValleyPluginApi): WorkspaceStore {
  initRuntime(api)
  const holder = api.runtime.getOrCreate<{ current: WorkspaceStore | null }>(STORE_KEY, () => ({ current: null }))
  holder.current?.dispose()
  const store = new WorkspaceStore(api)
  holder.current = store
  return store
}

/** The live store, or null before `register()` has run. */
export function getStore(): WorkspaceStore | null {
  return runtimeApi.runtime.getOrCreate<{ current: WorkspaceStore | null }>(STORE_KEY, () => ({ current: null })).current
}
