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
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { WorkspaceLayoutState, projectSnapshot, scopesOf, type LayoutScope, type LayoutScopes } from './layoutState'
import { WorkspaceRepository, GROUPS_DATASET, LAYOUTS_DATASET, dedupeGroups, normalizeLayout, type SavedLayout } from './repository'
export type { SavedLayout } from './repository'
export { structuralSnapshotKey, layoutCounts, scopesOf, LAYOUT_SCOPES, type LayoutScope, type LayoutScopes } from './layoutState'
import { api as runtimeApi, initRuntime } from './runtime'

const STORE_KEY = 'workspace.store'
const ACTIVE_SETTING = 'active'
export class WorkspaceStore {
  layouts: SavedLayout[] = []
  /** Groups created on their own; they stay listed while they hold no layout. */
  declaredGroups: string[] = []
  active: string | null = null
  private loaded = false
  private disposed = false
  private refreshRevision = 0
  private refreshPromise: Promise<void> | null = null
  private readonly repository: WorkspaceRepository
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: (() => void)[] = []
  private readonly layoutState: WorkspaceLayoutState
  private projection: {
    layouts: SavedLayout[]
    declaredGroups: string[]
    byName: Map<string, SavedLayout>
    groups: { group: string; layouts: SavedLayout[] }[]
    groupNames: string[]
    groupKeys: Set<string>
  } | null = null

  constructor(private readonly api: ValleyPluginApi) {
    this.layoutState = new WorkspaceLayoutState(api, () => this.notify())
    this.repository = new WorkspaceRepository(api, () => this.notify())
    this.cleanups.push(api.runtime.onBeforeUnload(() => this.repository.drain()))
    this.cleanups.push(api.settings.subscribe(() => this.notify()))
    const refresh = (): void => { if (this.loaded || this.refreshPromise) void this.refresh() }
    this.cleanups.push(api.data.dataset(GROUPS_DATASET).subscribe(refresh))
    this.cleanups.push(api.data.dataset(LAYOUTS_DATASET).subscribe(refresh))
  }

  dispose(): void {
    this.disposed = true
    this.layoutState.dispose()
    this.cleanups.splice(0).forEach((off) => off())
    this.listeners.clear()
  }

  /** Load the persisted list + active name once (idempotent). */
  ensureLoaded(): Promise<void> {
    if (this.loaded || this.disposed) return Promise.resolve()
    return this.refreshPromise ?? this.refresh()
  }

  /** Re-read the list from disk (e.g. another window mutated it). */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.refreshRevision++
    if (this.refreshPromise) return this.refreshPromise
    const pending = this.readLatest().finally(() => {
      if (this.refreshPromise === pending) this.refreshPromise = null
    })
    this.refreshPromise = pending
    void pending.catch(() => {})
    return pending
  }

  private async readLatest(): Promise<void> {
    while (!this.disposed) {
      const writes = this.repository.pending
      await writes
      if (this.disposed || this.repository.failure) return
      if (writes !== this.repository.pending) continue
      const revision = this.refreshRevision
      const records = await Promise.allSettled([
        this.repository.readDataset(LAYOUTS_DATASET, () => this.disposed),
        this.repository.readDataset(GROUPS_DATASET, () => this.disposed)
      ])
      if (this.disposed) return
      if (revision !== this.refreshRevision || writes !== this.repository.pending) continue
      const failed = records.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      const [layouts, groups] = records.map((result) => result.status === 'fulfilled' ? result.value : [])
      this.layouts = layouts
        .map((r) => normalizeLayout(r))
        .filter((l): l is SavedLayout => l !== null)
        .sort((a, b) => a.name.localeCompare(b.name))
      this.declaredGroups = dedupeGroups(groups
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((record) => typeof record.name === 'string' ? record.name.trim() : ''))
      const settingActive = this.api.settings.get()[ACTIVE_SETTING]
      this.active = typeof settingActive === 'string' && this.find(settingActive) ? settingActive : null
      this.loaded = true
      this.notify()
      if (revision === this.refreshRevision) return
    }
  }

  private indexed() {
    if (this.projection?.layouts === this.layouts && this.projection.declaredGroups === this.declaredGroups) return this.projection
    const byName = new Map<string, SavedLayout>()
    for (const layout of this.layouts) {
      const key = layout.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, layout)
    }
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
    const groups = [...byGroup.entries()]
      .map(([key, layouts]) => ({ group: labels.get(key) ?? key, layouts }))
      .sort((a, b) => (a.group === '' ? 1 : b.group === '' ? -1 : a.group.localeCompare(b.group)))
    const groupNames = groups.map(group => group.group).filter(group => group !== '')
    return this.projection = {
      layouts: this.layouts, declaredGroups: this.declaredGroups, byName, groups, groupNames,
      groupKeys: new Set(groupNames.map(group => group.toLowerCase()))
    }
  }

  find(name: string): SavedLayout | undefined { return this.indexed().byName.get(name.trim().toLowerCase()) }

  groups(): { group: string; layouts: SavedLayout[] }[] { return this.indexed().groups }

  groupNames(): string[] { return this.indexed().groupNames }

  hasGroup(name: string): boolean {
    const key = name.trim().toLowerCase()
    return key !== '' && this.indexed().groupKeys.has(key)
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

  capture(scopes?: LayoutScopes): WorkspaceLayoutSnapshot { return this.layoutState.capture(scopes) }
  captureForSave(scopes: LayoutScopes, prior?: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot { return this.layoutState.captureForSave(scopes, prior) }
  defaultScopes(): LayoutScopes { return this.layoutState.defaultScopes() }
  isCurrent(snapshot: WorkspaceLayoutSnapshot): boolean { return this.layoutState.isCurrent(snapshot) }
  applySnapshot(snapshot: WorkspaceLayoutSnapshot): void { this.layoutState.applySnapshot(snapshot) }

  /**
   * Capture the live arrangement and save it under `name`, then make it active.
   * Replacing an existing layout keeps its group and its saved parts unless the
   * caller names new ones; a new layout starts from the settings' defaults.
   */
  async saveCurrent(name: string, group?: string, scopes?: LayoutScopes): Promise<SavedLayout> {
    const prior = this.find(name)
    const now = Date.now()
    const chosen = scopes ?? (prior ? scopesOf(prior.snapshot) : this.defaultScopes())
    const layout: SavedLayout = {
      name,
      group: group?.trim() || prior?.group || '',
      snapshot: this.captureForSave(chosen, prior?.snapshot),
      createdAt: prior?.createdAt ?? now,
      modifiedAt: now
    }
    await this.upsert(layout)
    await this.setActive(name)
    return layout
  }

  /** Copy a layout under the first free "<name> copy" name; the copy stays inactive. */
  async duplicate(name: string, copyLabel: (base: string, n: number) => string): Promise<SavedLayout> {
    const source = this.find(name)
    if (!source) throw new Error(`No saved layout named "${name}".`)
    let n = 1
    let next = copyLabel(source.name, n)
    while (this.find(next)) next = copyLabel(source.name, ++n)
    const now = Date.now()
    const copy: SavedLayout = { ...source, name: next, createdAt: now, modifiedAt: now }
    await this.upsert(copy)
    return copy
  }

  /**
   * Add or drop one optional part of a saved layout. Adding captures that part
   * from the live workspace; dropping removes it, so loading the layout leaves
   * that part of the live workspace alone.
   */
  async setScope(name: string, scope: LayoutScope, included: boolean): Promise<SavedLayout> {
    const prior = this.find(name)
    if (!prior) throw new Error(`No saved layout named "${name}".`)
    const kept = projectSnapshot(prior.snapshot, { ...scopesOf(prior.snapshot), [scope]: included })
    const snapshot = included ? this.layoutState.withLivePart(kept, scope) : kept
    const next: SavedLayout = { ...prior, snapshot, modifiedAt: Date.now() }
    await this.upsert(next)
    return next
  }

  /** Re-capture any saved layout from the live workspace, keeping its parts and group. */
  replaceWithCurrent(name: string): Promise<SavedLayout> {
    const target = this.find(name)
    if (!target) return Promise.reject(new Error(`No saved layout named "${name}".`))
    return this.saveCurrent(target.name, target.group)
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
    let owned: SavedLayout
    try { owned = JSON.parse(JSON.stringify(layout)) }
    catch (error) { return this.repository.reject(error) }
    const next = this.layouts.filter((l) => l.name.toLowerCase() !== owned.name.toLowerCase())
    next.push(owned)
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
    this.layouts = this.layouts.map((layout, index) => index === idx ? { ...layout, group: group.trim() } : layout)
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

  private persist(): Promise<void> { return this.repository.save(this.layouts, this.declaredGroups) }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    if (this.disposed) return
    this.listeners.forEach((l) => l())
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
