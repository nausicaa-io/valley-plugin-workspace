import { WORKSPACE_VIEW_STATE_V1, type InteropExtensionProvider, type ValleyPluginApi, type WorkspaceViewStateProvider } from '@valley/plugin-sdk'
import type { WorkspaceLayoutSnapshot, WorkspaceNode, WorkspacePluginViewState, WorkspaceViewStateValue, WorkspaceViewSurface } from '@valley/plugin-sdk/types'

const ICON_RAIL_SETTING = 'saveIconRail'
const FOOTER_RAIL_SETTING = 'saveFooterRail'
const RIGHT_SIDEBAR_SETTING = 'saveRightSidebarState'

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

}
