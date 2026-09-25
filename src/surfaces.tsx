import { PLUGIN_SURFACE_V1, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { SlotId } from '@valley/plugin-sdk/types'
import { React, api } from './runtime'
import { getStore } from './store'
import { uiText } from './localization'

export type ManagerFocus = 'search' | 'save'
interface WorkspaceView { query: string; selected: string | null; managerOpen: boolean; managerFocus: ManagerFocus }
interface SurfaceState { views: Map<SlotId, WorkspaceView>; listeners: Set<() => void>; footerMounts: number }
function state(): SurfaceState { return api.runtime.getOrCreate('workspace.surfaces', () => ({ views: new Map(), listeners: new Set(), footerMounts: 0 })) }
function view(surface: SlotId): WorkspaceView {
  let value = state().views.get(surface)
  if (!value) { value = { query: '', selected: null, managerOpen: false, managerFocus: 'search' }; state().views.set(surface, value) }
  return value
}
function subscribe(listener: () => void): () => void {
  const listeners = state().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function notify(): void { state().listeners.forEach((listener) => listener()) }
export function patchWorkspaceSurface(surface: SlotId, patch: Partial<WorkspaceView>): void { Object.assign(view(surface), patch); notify() }
/** Count a mounted footer chip, which is what renders the manager modal. */
export function useFooterMount(): void {
  React.useEffect(() => {
    state().footerMounts += 1
    return () => { state().footerMounts -= 1 }
  }, [])
}

/**
 * Open the manager modal behind the footer chip. Returns false when no footer
 * chip is mounted (the user hid it), so the caller can fall back to the panel.
 */
export function openManager(focus: ManagerFocus): boolean {
  if (state().footerMounts <= 0) return false
  patchWorkspaceSurface('footer', { managerOpen: true, managerFocus: focus })
  return true
}

export function useWorkspaceSurface(surface: SlotId): WorkspaceView {
  const [, update] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => subscribe(update), [])
  return view(surface)
}

export function registerWorkspaceSurfaces(pluginApi: ValleyPluginApi): () => void {
  const surfaces = ['left_sidebar', 'footer'] as const
  const offs = surfaces.map((surface) => pluginApi.interop.extensions.provide(PLUGIN_SURFACE_V1, {
    id: `workspace.${surface}`, surface, subscribe,
    getSnapshot: () => {
      const current = view(surface)
      const store = getStore()
      const layout = store?.find(current.selected ?? store.active ?? '')
      return { title: uiText('auto.4ca0a75c2b7f'), view: { query: current.query }, ...(layout ? { item: { id: layout.name, title: layout.name, state: { query: current.query, name: layout.name } } } : {}) }
    },
    restore: async (raw, _instance, options) => {
      await getStore()?.ensureLoaded()
      const name = typeof raw.name === 'string' ? raw.name : null
      if (name && !getStore()?.find(name)) throw new Error(uiText('surface.unavailable'))
      patchWorkspaceSurface(surface, { query: typeof raw.query === 'string' ? raw.query : '', selected: name, ...(surface === 'footer' && !options?.background ? { managerOpen: true } : {}) })
    }
  }))
  const offStore = getStore()?.subscribe(notify)
  return () => { offStore?.(); offs.forEach((off) => off()) }
}
