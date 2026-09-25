import { WORKSPACE_VIEW_STATE_V1, type InteropExtensionProvider, type ValleyPluginApi, type WorkspaceViewStateProvider } from '@valley/plugin-sdk'
import type { LeafPane, WorkspaceLayoutSnapshot, WorkspaceNode, WorkspacePluginViewState, WorkspaceViewStateValue, WorkspaceViewSurface } from '@valley/plugin-sdk/types'

const ICON_RAIL_SETTING = 'saveIconRail'
const FOOTER_RAIL_SETTING = 'saveFooterRail'
const RIGHT_SIDEBAR_SETTING = 'saveRightSidebarState'

/**
 * The optional parts a layout can carry beside the always-saved pane tree and
 * left sidebar. Each saved layout owns its own choice; the settings only seed
 * the choice for a new layout.
 */
export type LayoutScope = 'rightSidebar' | 'iconRail' | 'footer'
export type LayoutScopes = Record<LayoutScope, boolean>
export const LAYOUT_SCOPES: readonly LayoutScope[] = ['rightSidebar', 'iconRail', 'footer']

const SCOPE_FIELDS = {
  rightSidebar: ['rightSidebarWidth', 'rightSidebarVisible', 'rightSidebarLayout'],
  iconRail: ['railVisible', 'panelOrder', 'hiddenPanelIds'],
  footer: ['footerVisible', 'footerLayout']
} as const satisfies Record<LayoutScope, readonly (keyof WorkspaceLayoutSnapshot)[]>

/** Which optional parts a saved snapshot carries, read from the fields present. */
export function scopesOf(snapshot: WorkspaceLayoutSnapshot): LayoutScopes {
  const has = (scope: LayoutScope): boolean => SCOPE_FIELDS[scope].some((key) => snapshot[key] != null)
  return { rightSidebar: has('rightSidebar'), iconRail: has('iconRail'), footer: has('footer') }
}

/** Keep only the always-saved fields plus the parts `scopes` selects. */
export function projectSnapshot(raw: WorkspaceLayoutSnapshot, scopes: LayoutScopes): WorkspaceLayoutSnapshot {
  const snapshot = storedSnapshot(raw)
  const projected: WorkspaceLayoutSnapshot = {
    layout: snapshot.layout,
    activePaneId: snapshot.activePaneId,
    leftSidebarWidth: snapshot.leftSidebarWidth,
    leftSidebarVisible: snapshot.leftSidebarVisible,
    ...(snapshot.activePanel ? { activePanel: snapshot.activePanel } : {})
  }
  for (const scope of LAYOUT_SCOPES) {
    if (!scopes[scope]) continue
    for (const key of SCOPE_FIELDS[scope]) if (snapshot[key] != null) Object.assign(projected, { [key]: snapshot[key] })
  }
  const pluginViewStates = snapshot.pluginViewStates?.filter((entry) =>
    entry.surface !== 'right_sidebar' || scopes.rightSidebar
  )
  if (pluginViewStates?.length) projected.pluginViewStates = pluginViewStates
  return projected
}

/** Pane and tab counts of the main workspace, for the layout lists. */
export function layoutCounts(snapshot: WorkspaceLayoutSnapshot): { panes: number; tabs: number } {
  const leaves = (node: WorkspaceNode): LeafPane[] => node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
  const panes = snapshot.layout ? leaves(snapshot.layout) : []
  return { panes: panes.length, tabs: panes.reduce((total, pane) => total + pane.tabs.length, 0) }
}

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

// Reading position inside a tab (scroll offset, media time, per-tab history)
// changes while the user reads; it never makes the arrangement itself unsaved.
const TRANSIENT_TAB_FIELDS = new Set(['scrollTop', 'viewState', 'recentTargets', 'historyIndex'])

function arrangementOnly(node: WorkspaceNode | undefined): WorkspaceNode | undefined {
  if (!node) return node
  if (node.type === 'split') return { ...node, children: node.children.map((child) => arrangementOnly(child) as WorkspaceNode) }
  return {
    ...node,
    tabs: node.tabs.map((tab) => Object.fromEntries(Object.entries(tab).filter(([key]) => !TRANSIENT_TAB_FIELDS.has(key))) as typeof tab)
  }
}

function arrangementKey(snapshot: WorkspaceLayoutSnapshot): string {
  return structuralSnapshotKey({
    ...snapshot,
    layout: arrangementOnly(snapshot.layout) as WorkspaceNode,
    ...(snapshot.rightSidebarLayout ? { rightSidebarLayout: arrangementOnly(snapshot.rightSidebarLayout) as WorkspaceLayoutSnapshot['rightSidebarLayout'] } : {})
  })
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
export function storedSnapshot(raw: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
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

export class WorkspaceLayoutState {
  private readonly unsubscribe: () => void
  private providerCleanups: (() => void)[] = []
  private disposed = false

  constructor(private readonly api: ValleyPluginApi, private readonly notify: () => void) {
    this.unsubscribe = api.interop.extensions.subscribe(WORKSPACE_VIEW_STATE_V1, () => {
      if (this.disposed) return
      this.bindProviderSubscriptions()
      this.notify()
    })
    this.bindProviderSubscriptions()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.providerCleanups.splice(0).forEach(off => off())
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

  /** The parts a new layout includes unless the user changes them while saving. */
  defaultScopes(): LayoutScopes {
    const settings = this.api.settings.get()
    return {
      rightSidebar: settings[RIGHT_SIDEBAR_SETTING] !== false,
      iconRail: settings[ICON_RAIL_SETTING] !== false,
      footer: settings[FOOTER_RAIL_SETTING] === true
    }
  }

  private captureProviderStates(snapshot: WorkspaceLayoutSnapshot, scopes: LayoutScopes): WorkspacePluginViewState[] {
    const states: WorkspacePluginViewState[] = []
    for (const provider of this.providers()) {
      const extension = provider.extension
      if (extension.surface === 'right_sidebar' && !scopes.rightSidebar) continue
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

  /** Capture the live workspace arrangement, limited to `scopes`. */
  capture(scopes: LayoutScopes = this.defaultScopes()): WorkspaceLayoutSnapshot {
    const snapshot = projectSnapshot(this.api.workspace.captureLayout(), scopes)
    const pluginViewStates = this.captureProviderStates(snapshot, scopes)
    return pluginViewStates.length > 0 ? { ...snapshot, pluginViewStates } : snapshot
  }

  /** Capture for persistence, retaining an unavailable provider's opaque state. */
  captureForSave(scopes: LayoutScopes, prior?: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
    const snapshot = this.capture(scopes)
    const current = new Map((snapshot.pluginViewStates ?? []).map((entry) => [stateKey(entry), entry]))
    for (const entry of projectSnapshot(prior ?? snapshot, scopes).pluginViewStates ?? []) {
      if (current.has(stateKey(entry))) continue
      if (!ownerPresent(snapshot, entry.surface, entry.owner)) continue
      current.set(stateKey(entry), entry)
    }
    const pluginViewStates = normalizePluginViewStates([...current.values()])
    return pluginViewStates ? { ...snapshot, pluginViewStates } : snapshot
  }

  /** `snapshot` with one optional part replaced by its live state. */
  withLivePart(snapshot: WorkspaceLayoutSnapshot, scope: LayoutScope): WorkspaceLayoutSnapshot {
    const live = this.capture({ rightSidebar: false, iconRail: false, footer: false, [scope]: true })
    const next: WorkspaceLayoutSnapshot = { ...snapshot }
    for (const key of SCOPE_FIELDS[scope]) if (live[key] != null) Object.assign(next, { [key]: live[key] })
    if (scope !== 'rightSidebar') return next
    const states = new Map((snapshot.pluginViewStates ?? []).map((entry) => [stateKey(entry), entry]))
    for (const entry of live.pluginViewStates ?? []) if (entry.surface === 'right_sidebar') states.set(stateKey(entry), entry)
    const pluginViewStates = normalizePluginViewStates([...states.values()])
    if (pluginViewStates) next.pluginViewStates = pluginViewStates
    return next
  }

  /** Whether the live workspace still matches `snapshot` in every part it saved. */
  isCurrent(snapshot: WorkspaceLayoutSnapshot): boolean {
    const scopes = scopesOf(snapshot)
    const live = this.capture(scopes)
    const available = new Set(this.providers().map((provider) => providerKey(provider.owner, provider.extension)))
    const saved = projectSnapshot(snapshot, scopes)
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
    return arrangementKey(live) === arrangementKey(comparable)
  }

  /** Restore an arrangement into the live workspace. */
  applySnapshot(snapshot: WorkspaceLayoutSnapshot): void {
    const projected = projectSnapshot(snapshot, scopesOf(snapshot))
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

}
