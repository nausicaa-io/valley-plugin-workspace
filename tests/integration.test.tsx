import React, { type ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore, getStore } from '../src/store'
import { registerWorkspaceCommands } from '../src/commands'
import { register } from '../src/index'
import { initRuntime } from '../src/runtime'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { LeafPane, WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { PLUGIN_SURFACE_V1, METADATA_PANEL_SEGMENT_V1, WORKSPACE_VIEW_STATE_V1, type WorkspaceViewStateProvider } from '@valley/plugin-sdk'
import { ago } from '../src/ui'

const NS = 'test-plugin' // createMockValleyApi's manifest id

afterEach(() => cleanup())

function setup() {
  const mock = createMockValleyApi()
  initRuntime(mock.api)
  createStore(mock.api)
  const off = registerWorkspaceCommands(mock.api)
  return { api: mock.api, off, mock }
}

async function datasetRows(api: ReturnType<typeof setup>['api'], dataset: string): Promise<Record<string, unknown>[]> {
  return (await api.data.dataset(dataset).query({ limit: 1000 })).rows as Record<string, unknown>[]
}

async function selectLatestMenu(mock: ReturnType<typeof createMockValleyApi>, label: string): Promise<void> {
  const item = mock.menus.at(-1)?.find((candidate) => candidate.label === label)
  expect(item).toBeDefined()
  await act(async () => {
    await item?.onSelect?.()
  })
}

function snapshot(
  id: string,
  // A `WorkspaceNode` may be a split, which has no `activeTabId`; this helper
  // always builds a leaf, so type the overrides against that.
  leafOverrides?: Partial<Pick<LeafPane, 'activeTabId' | 'tabs'>>
): WorkspaceLayoutSnapshot {
  return {
    layout: { type: 'leaf', id, activeTabId: '', tabs: [], ...leafOverrides },
    leftSidebarWidth: 260,
    rightSidebarWidth: 280,
    leftSidebarVisible: true,
    rightSidebarVisible: false
  }
}

function scopedSnapshot(id: string): WorkspaceLayoutSnapshot {
  return {
    ...snapshot(id),
    activePanel: 'test-plugin',
    rightSidebarVisible: true,
    rightSidebarLayout: {
      type: 'leaf',
      id: `${id}-right`,
      activeTabId: `${id}-plugin`,
      tabs: [{ id: `${id}-plugin`, folderPath: '', kind: 'plugin', pluginId: 'test-plugin' }]
    },
    railVisible: false,
    panelOrder: ['test-plugin', 'files'],
    hiddenPanelIds: ['search'],
    footerVisible: false,
    footerLayout: { left: ['vault'], right: ['save'], hidden: ['player'] }
  }
}

describe('workspace scope settings and view-state providers', () => {
  it('defaults to right-sidebar capture while Icon Rail and Footer Rail stay independent', async () => {
    const defaults = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(defaults.api.workspace.captureLayout).mockReturnValue(scopedSnapshot('default'))
    const defaultStore = createStore(defaults.api)
    const captured = defaultStore.capture()
    expect(captured).toMatchObject({
      activePanel: 'test-plugin',
      rightSidebarVisible: true,
      rightSidebarLayout: expect.objectContaining({ id: 'default-right' })
    })
    expect(captured).not.toHaveProperty('railVisible')
    expect(captured).not.toHaveProperty('footerVisible')

    const custom = createMockValleyApi({
      manifest: { id: 'workspace' },
      settings: { saveIconRail: true, saveFooterRail: true, saveRightSidebarState: false }
    })
    vi.mocked(custom.api.workspace.captureLayout).mockReturnValue(scopedSnapshot('custom'))
    const customStore = createStore(custom.api)
    const projected = customStore.capture()
    expect(projected).toMatchObject({
      railVisible: false,
      panelOrder: ['test-plugin', 'files'],
      hiddenPanelIds: ['search'],
      footerVisible: false,
      footerLayout: { left: ['vault'], right: ['save'], hidden: ['player'] }
    })
    expect(projected).not.toHaveProperty('rightSidebarVisible')
    expect(projected).not.toHaveProperty('rightSidebarLayout')
  })

  it('compares and applies only enabled scopes', () => {
    const mock = createMockValleyApi({
      manifest: { id: 'workspace' },
      settings: { saveIconRail: false, saveFooterRail: false, saveRightSidebarState: false }
    })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(scopedSnapshot('same'))
    const store = createStore(mock.api)
    const saved = {
      ...scopedSnapshot('same'),
      railVisible: true,
      footerVisible: true,
      rightSidebarVisible: false
    }
    expect(store.isCurrent(saved)).toBe(true)

    store.applySnapshot(saved)
    expect(mock.api.workspace.applyLayout).toHaveBeenCalledWith({
      layout: saved.layout,
      activePaneId: saved.activePaneId,
      leftSidebarWidth: saved.leftSidebarWidth,
      leftSidebarVisible: saved.leftSidebarVisible,
      activePanel: saved.activePanel
    })
  })

  it('preserves unavailable opaque provider state and restores it after the provider returns', () => {
    const mock = createMockValleyApi({ manifest: { id: 'test-plugin' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(scopedSnapshot('provider'))
    const restore = vi.fn()
    const provider: WorkspaceViewStateProvider = {
      id: 'test.right',
      surface: 'right_sidebar',
      capture: () => ({ expanded: true }),
      restore,
      subscribe: () => () => {}
    }
    const stopProvider = mock.api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, provider)
    const store = createStore(mock.api)
    const first = store.captureForSave()
    expect(first.pluginViewStates).toEqual([{
      owner: 'test-plugin',
      id: 'test.right',
      surface: 'right_sidebar',
      state: { expanded: true }
    }])

    stopProvider()
    const preserved = store.captureForSave(first)
    expect(preserved.pluginViewStates).toEqual(first.pluginViewStates)
    store.applySnapshot(preserved)
    expect(restore).not.toHaveBeenCalled()

    mock.api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, provider)
    store.applySnapshot(preserved)
    expect(restore).toHaveBeenCalledWith({ expanded: true })
  })

  it('isolates a failing provider from host and peer restoration', () => {
    const mock = createMockValleyApi({ manifest: { id: 'test-plugin' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(scopedSnapshot('isolated'))
    const peerRestore = vi.fn()
    mock.api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, {
      id: 'test.bad',
      surface: 'right_sidebar',
      capture: () => ({ bad: true }),
      restore: () => { throw new Error('broken provider') },
      subscribe: () => () => {}
    })
    mock.api.interop.extensions.provide(WORKSPACE_VIEW_STATE_V1, {
      id: 'test.peer',
      surface: 'right_sidebar',
      capture: () => ({ peer: true }),
      restore: peerRestore,
      subscribe: () => () => {}
    })
    const store = createStore(mock.api)
    const saved = store.capture()

    expect(() => store.applySnapshot(saved)).not.toThrow()
    expect(mock.api.workspace.applyLayout).toHaveBeenCalled()
    expect(peerRestore).toHaveBeenCalledWith({ peer: true })
  })
})

describe('workspace display localization', () => {
  it('formats generated relative times in the active language', () => {
    const zh = createMockValleyApi({ overrides: { ui: { language: () => 'zh-CN' } } })
    initRuntime(zh.api)
    expect(ago(Date.now() - 15 * 24 * 60 * 60 * 1000)).toBe('15天前')

    const de = createMockValleyApi({ overrides: { ui: { language: () => 'de' } } })
    initRuntime(de.api)
    expect(ago(Date.now() - 15 * 24 * 60 * 60 * 1000)).toBe('vor 15 Tagen')
  })
})

describe('workspace plugin commands', () => {
  it('saves, lists, loads and deletes a named layout', async () => {
    const { api } = setup()

    const saved = await api.commands.execute(`${NS}:save`, { name: 'Canopy', group: 'Fungi' })
    expect(saved.ok).toBe(true)

    const records = await datasetRows(api, 'test-plugin.workspace_layouts')
    expect(records).toHaveLength(1)
    expect(records[0].name).toBe('Canopy')
    expect(records[0].group).toBe('Fungi')
    expect(records[0].snapshot).toBeTruthy()

    const listed = await api.commands.execute(`${NS}:list`, undefined)
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      const value = listed.value as { active: string | null; layouts: { name: string; group: string }[] }
      expect(value.layouts.map((l) => l.name)).toEqual(['Canopy'])
      expect(value.active).toBe('Canopy')
    }

    // Loading applies the exact snapshot that was captured at save time.
    const target = getStore()?.find('Canopy')
    const loaded = await api.commands.execute(`${NS}:load`, { name: 'Canopy' })
    expect(loaded.ok).toBe(true)
    expect(api.workspace.applyLayout).toHaveBeenCalledWith(target?.snapshot)

    const deleted = await api.commands.execute(`${NS}:delete`, { name: 'Canopy' })
    expect(deleted.ok).toBe(true)
    expect(await datasetRows(api, 'test-plugin.workspace_layouts')).toHaveLength(0)
    expect(getStore()?.active).toBeNull()
  })

  it('deselects the active layout (and reverts), leaving saved layouts intact', async () => {
    const { api, mock } = setup()
    await api.commands.execute(`${NS}:save`, { name: 'Canopy' })
    expect(getStore()?.active).toBe('Canopy')

    const res = await api.commands.execute(`${NS}:deselect`, undefined)
    expect(res.ok).toBe(true)
    expect(getStore()?.active).toBeNull()
    // The saved layout itself is untouched.
    expect(await datasetRows(api, 'test-plugin.workspace_layouts')).toHaveLength(1)

    // The bus-registered revert restores the prior active pointer.
    const undo = mock.busUndo[mock.busUndo.length - 1]
    await undo.undo()
    expect(getStore()?.active).toBe('Canopy')

    // Deselecting with nothing active is a no-op success (registers no revert).
    await api.commands.execute(`${NS}:deselect`, undefined)
    const before = mock.busUndo.length
    const again = await api.commands.execute(`${NS}:deselect`, undefined)
    expect(again.ok).toBe(true)
    expect(mock.busUndo.length).toBe(before)
  })

  it('rejects loading or deleting an unknown layout', async () => {
    const { api } = setup()
    const load = await api.commands.execute(`${NS}:load`, { name: 'nope' })
    expect(load.ok).toBe(false)
    const del = await api.commands.execute(`${NS}:delete`, { name: 'nope' })
    expect(del.ok).toBe(false)
  })

  it('rejects a save with no name', async () => {
    const { api } = setup()
    const res = await api.commands.execute(`${NS}:save`, { name: '   ' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.kind).toBe('invalid-input')
  })

  it('groups layouts and overwrites by name (case-insensitive)', async () => {
    const { api } = setup()
    await api.commands.execute(`${NS}:save`, { name: 'A', group: 'G1' })
    await api.commands.execute(`${NS}:save`, { name: 'B', group: 'G1' })
    await api.commands.execute(`${NS}:save`, { name: 'a' }) // overwrites 'A'

    const store = getStore()!
    expect(store.layouts.map((l) => l.name).sort()).toEqual(['B', 'a'])
    const groups = store.groups()
    // ungrouped sorts last; 'a' moved out of G1 by the overwrite.
    expect(groups.find((g) => g.group === 'G1')?.layouts.map((l) => l.name)).toEqual(['B'])
    expect(groups[groups.length - 1].group).toBe('')
  })

  it('creates a group with no layout in it, persists it beside the layouts, and reverts', async () => {
    const { api, mock } = setup()

    const created = await api.commands.execute(`${NS}:group-create`, { name: '  Test  ' })
    expect(created.ok).toBe(true)
    const store = getStore()!
    expect(store.layouts).toHaveLength(0)
    expect(store.groups().map((g) => g.group)).toEqual(['Test'])
    expect(store.hasGroup('test')).toBe(true) // case-insensitive

    expect(await datasetRows(api, 'test-plugin.workspace_groups')).toEqual([{ name: 'Test', position: 0 }])

    // A name that already exists is refused, whatever its case.
    expect((await api.commands.execute(`${NS}:group-create`, { name: 'TEST' })).ok).toBe(false)

    // Saving into the group leaves exactly one group, not a case-twin.
    await api.commands.execute(`${NS}:save`, { name: 'Mycology', group: 'test' })
    expect(store.groups().map((g) => g.group)).toEqual(['Test'])
    expect(store.groups()[0].layouts.map((l) => l.name)).toEqual(['Mycology'])

    const undo = mock.busUndo[0]
    await undo.undo()
    expect(getStore()?.hasGroup('Test')).toBe(false)
  })

  it('an empty group survives a reload, and the store lists it for the group dropdown', async () => {
    const { api } = setup()
    await api.commands.execute(`${NS}:group-create`, { name: 'Season' })
    await api.commands.execute(`${NS}:save`, { name: 'Moss', group: 'Plants' })

    // A fresh store over the same shared file sees both the declared (empty)
    // group and the one implied by the saved layout.
    createStore(api)
    await getStore()?.ensureLoaded()
    expect(getStore()?.groupNames()).toEqual(['Plants', 'Season'])
    expect(getStore()?.groups().find((g) => g.group === 'Season')?.layouts).toEqual([])
  })

  it('renames and deletes a group, keeping its layouts (the revert restores membership)', async () => {
    const { api, mock } = setup()
    await api.commands.execute(`${NS}:save`, { name: 'A', group: 'Old' })
    await api.commands.execute(`${NS}:group-create`, { name: 'Empty' })

    expect((await api.commands.execute(`${NS}:group-rename`, { name: 'Old', to: 'New' })).ok).toBe(true)
    expect(getStore()?.find('A')?.group).toBe('New')
    // An empty group renames too — there is a declaration to carry across.
    expect((await api.commands.execute(`${NS}:group-rename`, { name: 'Empty', to: 'Later' })).ok).toBe(true)
    expect(getStore()?.groupNames()).toEqual(['Later', 'New'])
    expect((await api.commands.execute(`${NS}:group-rename`, { name: 'ghost', to: 'X' })).ok).toBe(false)

    const deleted = await api.commands.execute(`${NS}:group-delete`, { name: 'new' })
    expect(deleted.ok).toBe(true)
    // The layout itself survives; only its membership is dropped.
    expect(getStore()?.find('A')?.group).toBe('')
    expect(getStore()?.hasGroup('New')).toBe(false)

    await mock.busUndo[mock.busUndo.length - 1].undo()
    expect(getStore()?.find('A')?.group).toBe('New')

    const listed = await api.commands.execute(`${NS}:groups`, undefined)
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect((listed.value as { groups: { name: string; layouts: number }[] }).groups).toEqual([
        { name: 'Later', layouts: 0 },
        { name: 'New', layouts: 1 }
      ])
    }
  })

  it('moves a layout into and out of a group via setGroup (the ⋯ "Add to Group" action)', async () => {
    const { api } = setup()
    await api.commands.execute(`${NS}:save`, { name: 'X' })
    const store = getStore()!

    await store.setGroup('X', 'Fungi')
    expect(store.find('X')?.group).toBe('Fungi')

    await store.setGroup('x', '') // case-insensitive lookup, "Remove from group"
    expect(store.find('X')?.group).toBe('')

    await expect(store.setGroup('ghost', 'G')).rejects.toThrow()
  })

  it('renames a layout and moves the active pointer (rejects clash/unknown)', async () => {
    const { api } = setup()
    await api.commands.execute(`${NS}:save`, { name: 'Old', group: 'G' })
    const res = await api.commands.execute(`${NS}:rename`, { name: 'Old', to: 'New' })
    expect(res.ok).toBe(true)

    const store = getStore()!
    expect(store.layouts.map((l) => l.name)).toEqual(['New'])
    expect(store.find('New')?.group).toBe('G')
    expect(store.active).toBe('New')

    await api.commands.execute(`${NS}:save`, { name: 'Other' })
    expect((await api.commands.execute(`${NS}:rename`, { name: 'New', to: 'Other' })).ok).toBe(false)
    expect((await api.commands.execute(`${NS}:rename`, { name: 'ghost', to: 'X' })).ok).toBe(false)
  })

  it('save-active overwrites the active layout, or reveals the panel when none', async () => {
    const { api } = setup()
    const none = await api.commands.execute(`${NS}:save-active`, undefined)
    expect(none.ok).toBe(true)
    if (none.ok) expect((none.value as { name: string | null }).name).toBeNull()
    expect(api.workspace.revealOwnPanel).toHaveBeenCalledWith('left_sidebar')

    await api.commands.execute(`${NS}:save`, { name: 'Plants' })
    const saved = await api.commands.execute(`${NS}:save-active`, undefined)
    expect(saved.ok).toBe(true)
    if (saved.ok) expect((saved.value as { name: string | null }).name).toBe('Plants')
  })

  it('open loads and close deletes (CLI-friendly aliases)', async () => {
    const { api } = setup()
    await api.commands.execute(`${NS}:save`, { name: 'X' })
    const target = getStore()?.find('X')

    const opened = await api.commands.execute(`${NS}:open`, { name: 'X' })
    expect(opened.ok).toBe(true)
    expect(api.workspace.applyLayout).toHaveBeenCalledWith(target?.snapshot)

    const closed = await api.commands.execute(`${NS}:close`, { name: 'X' })
    expect(closed.ok).toBe(true)
    expect(getStore()?.layouts).toHaveLength(0)
  })

  it('opens the footer management modal to save, list, and explicitly load layouts without revealing the panel', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('f'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]
    expect(Footer).toBeDefined()

    await getStore()?.saveCurrent('Moss', 'Plants')
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('canopy'))
    await getStore()?.saveCurrent('Canopy', 'Fungi')
    render(React.createElement(Footer as ComponentType))
    await waitFor(() => expect(screen.getByText('Canopy')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Canopy' }))
    expect(mock.api.workspace.revealPanel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Manage workspace layouts' })).toBeInTheDocument()
    const saveField = screen.getByPlaceholderText('Save current workspace layout as…')
    fireEvent.change(saveField, { target: { value: 'Fresh layout' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(getStore()?.find('Fresh layout')).toBeDefined())
    expect(saveField).toHaveValue('')
    expect(screen.getByText('Active')).toBeInTheDocument()

    const deskRow = screen.getByTestId('workspace-switcher-row-Moss')
    expect(within(deskRow).getByText(/Modified/)).toBeInTheDocument()
    fireEvent.click(within(deskRow).getByRole('button', { name: 'Load workspace Moss' }))
    await waitFor(() => expect(mock.api.workspace.applyLayout).toHaveBeenCalledWith(expect.objectContaining({ layout: expect.objectContaining({ id: 'f' }) })))
    expect(screen.queryByRole('dialog', { name: 'Manage workspace layouts' })).not.toBeInTheDocument()
  })

  it('manages layouts from the modal by group, search, row click and the arrow-key highlight', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('moss'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]

    await getStore()?.saveCurrent('Moss', 'Plants')
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('canopy'))
    await getStore()?.saveCurrent('Canopy', 'Fungi')
    render(React.createElement(Footer as ComponentType))
    fireEvent.click(screen.getByRole('button', { name: 'Canopy' }))

    // Groups are headed and each row names the group it is saved in.
    expect(screen.getByTestId('workspace-switcher-group-Fungi')).toBeInTheDocument()
    const deskRow = screen.getByTestId('workspace-switcher-row-Moss')
    expect(within(deskRow).getByText('Plants')).toBeInTheDocument()

    // Search narrows the list (and therefore what the arrow keys walk).
    const search = screen.getByPlaceholderText('Search layouts & groups')
    fireEvent.change(search, { target: { value: 'plants' } })
    expect(screen.queryByTestId('workspace-switcher-row-Canopy')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '' } })

    // ↓ ↓ highlights the second visible row (Fungi/Canopy sorts after Plants/Moss),
    // Enter loads it — no Load button involved.
    const surface = screen.getByTestId('workspace-switcher')
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    fireEvent.keyDown(surface, { key: 'Enter' })
    await waitFor(() =>
      expect(mock.api.workspace.applyLayout).toHaveBeenCalledWith(
        expect.objectContaining({ layout: expect.objectContaining({ id: 'canopy' }) })
      )
    )
    expect(screen.queryByRole('dialog', { name: 'Manage workspace layouts' })).not.toBeInTheDocument()

    // Clicking anywhere on a row loads it too.
    fireEvent.click(screen.getByRole('button', { name: 'Canopy' }))
    fireEvent.click(
      within(screen.getByTestId('workspace-switcher-row-Moss')).getByRole('button', { name: 'Load workspace Moss' })
    )
    await waitFor(() =>
      expect(mock.api.workspace.applyLayout).toHaveBeenCalledWith(
        expect.objectContaining({ layout: expect.objectContaining({ id: 'moss' }) })
      )
    )
  })

  it('keeps the footer switcher open while canceling or confirming deletion', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('moss'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    await getStore()?.saveCurrent('Moss', 'Plants')
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]
    vi.mocked(mock.api.ui.confirm)
      .mockImplementationOnce(async (options) => {
        mock.confirmations.push(options)
        return null
      })
      .mockImplementationOnce(async (options) => {
        mock.confirmations.push(options)
        return 'delete'
      })

    render(React.createElement(Footer as ComponentType))
    fireEvent.click(screen.getByRole('button', { name: 'Moss' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace Moss' }))

    await waitFor(() => expect(mock.api.ui.confirm).toHaveBeenCalledTimes(1))
    expect(mock.api.workspace.applyLayout).not.toHaveBeenCalled()
    expect(getStore()?.find('Moss')).toBeDefined()
    expect(screen.getByRole('dialog', { name: 'Manage workspace layouts' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace Moss' }))
    await waitFor(() => expect(getStore()?.find('Moss')).toBeUndefined())
    expect(getStore()?.active).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Manage workspace layouts' })).toBeInTheDocument()
    expect(screen.getByText('No saved workspaces yet.')).toBeInTheDocument()
    expect(mock.api.workspace.applyLayout).not.toHaveBeenCalled()
  })

  it('lets the panel save changes back to the active layout via the ⋯ menu', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('first'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]
    expect(Panel).toBeDefined()

    const { rerender } = render(React.createElement(Panel as ComponentType))
    fireEvent.change(screen.getByPlaceholderText('Name this layout…'), { target: { value: 'Canopy' } })
    const groupField = screen.getByPlaceholderText('Group (optional)')
    fireEvent.change(groupField, { target: { value: 'Fungi' } })
    fireEvent.blur(groupField)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument())
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('changed'))
    rerender(React.createElement(Panel as ComponentType))
    // A diverged active layout shows no dot beside ACTIVE — the footer save
    // glyph is the only place divergence is reported.
    expect(screen.queryByTitle('Unsaved changes')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /More actions for Canopy/ }))
    await selectLatestMenu(mock, 'Save changes here')

    await waitFor(async () => {
      const records = await datasetRows(mock.api, 'workspace.workspace_layouts')
      expect((records[0].snapshot as WorkspaceLayoutSnapshot).layout.id).toBe('changed')
      expect(records[0].group).toBe('Fungi')
    })
  })

  it('renames a layout inline from the ⋯ menu', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('first'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]

    const { rerender } = render(React.createElement(Panel as ComponentType))
    fireEvent.change(screen.getByPlaceholderText('Name this layout…'), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Draft')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /More actions for Draft/ }))
    await selectLatestMenu(mock, 'Rename')
    const field = screen.getByDisplayValue('Draft')
    fireEvent.change(field, { target: { value: 'Final' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => expect(getStore()?.find('Final')).toBeTruthy())
    expect(getStore()?.find('Draft')).toBeUndefined()
    rerender(React.createElement(Panel as ComponentType))
    expect(screen.getByText('Final')).toBeInTheDocument()
  })

  it('uses the shared centered confirmation before deleting from the sidebar panel', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('panel-delete'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    await getStore()?.saveCurrent('Draft')
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]
    vi.mocked(mock.api.ui.confirm)
      .mockImplementationOnce(async (options) => {
        mock.confirmations.push(options)
        return null
      })
      .mockImplementationOnce(async (options) => {
        mock.confirmations.push(options)
        return 'delete'
      })

    render(React.createElement(Panel as ComponentType))
    fireEvent.click(screen.getByRole('button', { name: /More actions for Draft/ }))
    await selectLatestMenu(mock, 'Delete')
    expect(getStore()?.find('Draft')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /More actions for Draft/ }))
    await selectLatestMenu(mock, 'Delete')
    await waitFor(() => expect(getStore()?.find('Draft')).toBeUndefined())
    expect(mock.confirmations).toHaveLength(2)
    expect(mock.confirmations[0]).toMatchObject({
      title: 'Delete workspace?',
      actions: [
        { label: 'Cancel', value: 'cancel', variant: 'ghost' },
        { label: 'Delete', value: 'delete', variant: 'danger' }
      ]
    })
    const message = render(React.createElement(React.Fragment, null, mock.confirmations[0].message))
    expect(message.container.textContent).toBe('Draft will be permanently deleted.')
    message.unmount()
  })

  it('moves a layout between existing groups through the ⋯ menu submenu, and never offers a new one', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('g'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]
    const moveItem = (): { enabled?: boolean; submenu?: { label?: string; checked?: boolean }[] } | undefined =>
      mock.menus.at(-1)?.find((item) => item.label === 'Move to Group')

    const { rerender } = render(React.createElement(Panel as ComponentType))
    fireEvent.change(screen.getByPlaceholderText('Name this layout…'), { target: { value: 'Canopy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Canopy')).toBeInTheDocument())

    // With no group anywhere there is nowhere to move to, so the row is disabled
    // — inventing a group is the save field's job, never this menu's.
    fireEvent.click(screen.getByRole('button', { name: /More actions for Canopy/ }))
    expect(moveItem()?.enabled).toBe(false)
    expect(moveItem()?.submenu).toEqual([])

    // Name an unknown group in the save field and it exists from that moment.
    const groupField = screen.getByPlaceholderText('Group (optional)')
    fireEvent.change(groupField, { target: { value: 'Fungi' } })
    fireEvent.blur(groupField)
    await waitFor(() => expect(getStore()?.hasGroup('Fungi')).toBe(true))

    rerender(React.createElement(Panel as ComponentType))
    fireEvent.click(screen.getByRole('button', { name: /More actions for Canopy/ }))
    expect(moveItem()?.enabled).toBe(true)
    // Only existing groups; no "No group" row yet — the layout is in none.
    expect(moveItem()?.submenu?.map((item) => item.label)).toEqual(['Fungi'])
    await act(async () => {
      await (moveItem()?.submenu?.[0] as { onSelect?: () => Promise<void> })?.onSelect?.()
    })

    await waitFor(() => expect(getStore()?.find('Canopy')?.group).toBe('Fungi'))
    rerender(React.createElement(Panel as ComponentType))
    // The row moved under the "Fungi" group header (panel rows carry no chip —
    // the header names the group).
    const studyGroup = screen.getByTestId('workspace-group-Fungi')
    expect(within(studyGroup).getByTestId('workspace-layout-Canopy')).toBeInTheDocument()

    // Now in a group: its own entry is ticked and "No group" moves it back out.
    fireEvent.click(screen.getByRole('button', { name: /More actions for Canopy/ }))
    expect(moveItem()?.submenu?.map((item) => [item.label, item.checked])).toEqual([
      ['Fungi', true],
      ['No group', false]
    ])
    await act(async () => {
      await (moveItem()?.submenu?.[1] as { onSelect?: () => Promise<void> })?.onSelect?.()
    })
    await waitFor(() => expect(getStore()?.find('Canopy')?.group).toBe(''))
  })

  it('opens the row menu by right-click too, and only the active layout offers Deselect', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('ctx'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]

    await getStore()?.saveCurrent('Moss', 'Plants')
    await getStore()?.saveCurrent('Canopy', 'Plants')
    expect(getStore()?.active).toBe('Canopy')
    const { rerender } = render(React.createElement(Panel as ComponentType))

    // Right-click a non-active row: same items as `⋯`. Neither "Save changes
    // here" nor Deselect — both belong to the ACTIVE layout alone.
    fireEvent.contextMenu(screen.getByTestId('workspace-layout-Moss'), { clientX: 120, clientY: 240 })
    const deskItems = mock.menus.at(-1)?.map((item) => item.label)
    expect(deskItems).toEqual(['Rename', 'Move to Group', undefined, 'Delete'])

    // The active row adds both, and Deselect clears the ACTIVE pointer.
    fireEvent.contextMenu(screen.getByTestId('workspace-layout-Canopy'), { clientX: 120, clientY: 300 })
    expect(mock.menus.at(-1)?.map((item) => item.label)).toEqual([
      'Rename',
      'Move to Group',
      'Save changes here',
      'Deselect',
      undefined,
      'Delete'
    ])
    await selectLatestMenu(mock, 'Deselect')
    await waitFor(() => expect(getStore()?.active).toBeNull())
    rerender(React.createElement(Panel as ComponentType))
    expect(screen.queryByText('Active')).not.toBeInTheDocument()

    // Both are gone once nothing is active, from either entry point.
    fireEvent.click(screen.getByRole('button', { name: /More actions for Canopy/ }))
    expect(mock.menus.at(-1)?.map((item) => item.label)).toEqual(['Rename', 'Move to Group', undefined, 'Delete'])
  })

  it('reaches the same row menu from a right-click inside the manage modal', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('modal-ctx'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]

    await getStore()?.saveCurrent('Moss', 'Plants')
    render(React.createElement(Footer as ComponentType))
    fireEvent.click(screen.getByRole('button', { name: 'Moss' }))

    fireEvent.contextMenu(screen.getByTestId('workspace-switcher-row-Moss'), { clientX: 400, clientY: 300 })
    expect(mock.menus.at(-1)?.map((item) => item.label)).toContain('Deselect')
    await selectLatestMenu(mock, 'Deselect')
    await waitFor(() => expect(getStore()?.active).toBeNull())
    // Right-click must not load the layout.
    expect(mock.api.workspace.applyLayout).not.toHaveBeenCalled()
  })

  it('groups a saved layout by dragging it onto another group', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('drag'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const store = getStore()!
    await store.saveCurrent('Canopy', 'Fungi')
    await store.saveCurrent('Ecology', 'Wildlife')

    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]
    render(React.createElement(Panel as ComponentType))

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn((type: string) => (type === 'application/x-valley-workspace-layout' ? 'Canopy' : ''))
    }
    fireEvent.dragStart(screen.getByTestId('workspace-layout-Canopy'), { dataTransfer })
    fireEvent.dragOver(screen.getByTestId('workspace-group-Wildlife'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workspace-group-Wildlife'), { dataTransfer })

    await waitFor(() => expect(getStore()?.find('Canopy')?.group).toBe('Wildlife'))
  })

  it('creates a group by naming an unknown one in the save field — no layout saved, and it can be dropped into', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('groups'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]

    const { rerender } = render(React.createElement(Panel as ComponentType))
    const groupField = screen.getByPlaceholderText('Group (optional)')
    fireEvent.change(groupField, { target: { value: 'Season' } })
    fireEvent.blur(groupField)

    await waitFor(() => expect(getStore()?.hasGroup('Season')).toBe(true))
    expect(getStore()?.layouts).toHaveLength(0)
    rerender(React.createElement(Panel as ComponentType))
    // The empty group is listed, counts 0, and says it can take a layout.
    const block = screen.getByTestId('workspace-group-Season')
    expect(within(block).getByText('0')).toBeInTheDocument()
    expect(within(block).getByText('Empty — drag a layout here.')).toBeInTheDocument()

    // The layout saved next lands in it (the field kept the name).
    fireEvent.change(screen.getByPlaceholderText('Name this layout…'), { target: { value: 'Mycology' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(getStore()?.find('Mycology')?.group).toBe('Season'))

    // A second group, and the layout drags across into it.
    rerender(React.createElement(Panel as ComponentType))
    const nextField = screen.getByPlaceholderText('Group (optional)')
    fireEvent.change(nextField, { target: { value: 'Ecology' } })
    fireEvent.blur(nextField)
    await waitFor(() => expect(getStore()?.hasGroup('Ecology')).toBe(true))

    rerender(React.createElement(Panel as ComponentType))
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
      getData: vi.fn((type: string) => (type === 'application/x-valley-workspace-layout' ? 'Mycology' : ''))
    }
    fireEvent.dragStart(screen.getByTestId('workspace-layout-Mycology'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('workspace-group-Ecology'), { dataTransfer })
    await waitFor(() => expect(getStore()?.find('Mycology')?.group).toBe('Ecology'))
  })

  it('opens the group menu by right-click only — rename and delete, nothing for ungrouped', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('menu'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const store = getStore()!
    await store.saveCurrent('Moss', 'Plants')
    await store.saveCurrent('Loose', '')
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]

    const { rerender } = render(React.createElement(Panel as ComponentType))
    const headerLabel = (group: string): HTMLElement =>
      within(screen.getByTestId(`workspace-group-${group}`)).getByText(group)

    // No `⋯` on a group header — right-click is the only entry point.
    expect(screen.queryByRole('button', { name: /More actions for group/ })).not.toBeInTheDocument()
    fireEvent.contextMenu(headerLabel('Plants'), { clientX: 100, clientY: 200 })
    expect(mock.menus.at(-1)?.map((item) => item.label)).toEqual(['Rename group', undefined, 'Delete group'])

    // The ungrouped bucket has nothing to rename or delete, so it opens nothing.
    const before = mock.menus.length
    fireEvent.contextMenu(
      within(screen.getByTestId('workspace-group-ungrouped')).getByText('Ungrouped'),
      { clientX: 100, clientY: 260 }
    )
    expect(mock.menus.length).toBe(before)

    // Rename reuses the same inline editor as a double-click on the label.
    fireEvent.contextMenu(headerLabel('Plants'), { clientX: 100, clientY: 200 })
    await selectLatestMenu(mock, 'Rename group')
    const groupInput = screen.getByDisplayValue('Plants')
    fireEvent.change(groupInput, { target: { value: 'Studio' } })
    fireEvent.keyDown(groupInput, { key: 'Enter' })
    await waitFor(() => expect(getStore()?.find('Moss')?.group).toBe('Studio'))

    // Delete asks first, then keeps the layouts as ungrouped.
    vi.mocked(mock.api.ui.confirm).mockImplementationOnce(async (options) => {
      mock.confirmations.push(options)
      return 'delete'
    })
    rerender(React.createElement(Panel as ComponentType))
    fireEvent.contextMenu(headerLabel('Studio'), { clientX: 100, clientY: 200 })
    await selectLatestMenu(mock, 'Delete group')
    await waitFor(() => expect(getStore()?.hasGroup('Studio')).toBe(false))
    expect(getStore()?.find('Moss')?.group).toBe('')
    expect(getStore()?.layouts.map((l) => l.name).sort()).toEqual(['Loose', 'Moss'])
  })

  it('filters the saved-layout list by name/group via the top search bar', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('s'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const store = getStore()!
    await store.saveCurrent('PlantSurvey', 'Fungi')
    await store.saveCurrent('Cooking', '')

    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Panel = calls.find(([id]) => id === 'workspace.panel')?.[1]
    render(React.createElement(Panel as ComponentType))

    expect(screen.getByText('PlantSurvey')).toBeInTheDocument()
    expect(screen.getByText('Cooking')).toBeInTheDocument()

    const search = screen.getByPlaceholderText('Search layouts & groups')
    fireEvent.change(search, { target: { value: 'cook' } })
    expect(screen.queryByText('PlantSurvey')).not.toBeInTheDocument()
    expect(screen.getByText('Cooking')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'fungi' } }) // matches the group name, not the layout name
    expect(screen.getByText('PlantSurvey')).toBeInTheDocument()
    expect(screen.queryByText('Cooking')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzz-nope' } })
    expect(screen.getByText(/No matches/)).toBeInTheDocument()
  })

  it('swaps the footer save icon to a checkmark once saved, and back once the layout changes', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('a'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]

    const { rerender } = render(React.createElement(Footer as ComponentType))
    expect(screen.getByRole('button', { name: 'Save current layout' })).toBeInTheDocument()

    await act(async () => {
      await getStore()?.saveCurrent('Moss')
    })
    rerender(React.createElement(Footer as ComponentType))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved — no changes to save' })).toBeInTheDocument())

    // Switching to another open tab is an exact-layout change.
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('a', { activeTabId: 'other-tab' }))
    rerender(React.createElement(Footer as ComponentType))
    expect(screen.getByRole('button', { name: 'Save current layout' })).toBeInTheDocument()

    // Restoring the exact saved snapshot returns the double-check icon.
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(
      snapshot('a')
    )
    rerender(React.createElement(Footer as ComponentType))
    expect(screen.getByRole('button', { name: 'Saved — no changes to save' })).toBeInTheDocument()
  })

  it('saves an active layout directly from the footer without command Guard approval', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('before'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    await getStore()?.saveCurrent('Focus', 'Study')
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('after'))

    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]
    render(React.createElement(Footer as ComponentType))
    fireEvent.click(screen.getByRole('button', { name: 'Save current layout' }))

    await waitFor(() => expect(getStore()?.find('Focus')?.snapshot.layout).toMatchObject({ id: 'after' }))
    expect(getStore()?.find('Focus')?.group).toBe('Study')
    expect(mock.commandRuns.some((run) => run.id.endsWith(':save-active'))).toBe(false)
    expect(mock.api.ui.confirm).not.toHaveBeenCalled()
  })

  it('opens the manager with Save As focused when the footer has no active layout', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]
    render(React.createElement(Footer as ComponentType))

    fireEvent.click(screen.getByRole('button', { name: 'Save current layout' }))

    expect(screen.getByRole('dialog', { name: 'Manage workspace layouts' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Save current workspace layout as…')).toHaveAttribute(
      'data-modal-initial-focus',
      'true'
    )
  })

  it('ignores and removes an older right-sidebar scope while that setting is off', async () => {
    const legacy = {
      name: 'Legacy',
      group: '',
      snapshot: {
        rightSidebarVisible: false,
        rightSidebarLayout: { type: 'leaf', id: 'legacy-right', activeTabId: '', tabs: [] },
        leftSidebarVisible: true,
        rightSidebarWidth: 280,
        leftSidebarWidth: 260,
        layout: { type: 'leaf', id: 'legacy', activeTabId: '', tabs: [] }
      },
      createdAt: 1,
      modifiedAt: 1
    }
    const mock = createMockValleyApi({
      manifest: { id: 'workspace' },
      datasets: { 'workspace.workspace_layouts': [{ ...legacy, snapshotVersion: 1 }] },
      settings: { active: 'Legacy', saveRightSidebarState: false }
    })
    vi.mocked(mock.api.workspace.captureLayout).mockReturnValue(snapshot('legacy'))
    register(mock.api)
    await getStore()?.ensureLoaded()
    const calls = (mock.api.registerView as unknown as { mock: { calls: [string, ComponentType][] } }).mock.calls
    const Footer = calls.find(([id]) => id === 'workspace.footer')?.[1]

    render(React.createElement(Footer as ComponentType))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Saved — no changes to save' })).toBeInTheDocument()
    )

    // Resaving projects the disabled scope away.
    await act(async () => {
      await getStore()?.saveCurrent('Legacy', 'Craft')
    })
    const records = await datasetRows(mock.api, 'workspace.workspace_layouts')
    const stored = records.find((r) => r.name === 'Legacy')?.snapshot as Record<string, unknown>
    expect(stored).not.toHaveProperty('rightSidebarLayout')
    expect(stored).toHaveProperty('leftSidebarWidth', 260)
    expect(stored).not.toHaveProperty('rightSidebarVisible')
  })
})

describe('workspace contextual surfaces', () => {
  it('restores layout selection without applying a workspace or contributing Properties', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    const off = register(mock.api)
    const store = getStore()!
    await store.ensureLoaded()
    await store.saveCurrent('Fieldwork', 'Research')
    vi.mocked(mock.api.workspace.applyLayout).mockClear()
    const footer = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'footer')!.extension
    await footer.restore({ query: 'Field', name: 'Fieldwork' }, undefined, { background: true })
    expect(mock.api.workspace.applyLayout).not.toHaveBeenCalled()
    expect(footer.getSnapshot().item).toMatchObject({ id: 'Fieldwork', state: { name: 'Fieldwork' } })
    await expect(footer.restore({ name: 'Deleted' })).rejects.toThrow('unavailable')
    expect(mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)).toHaveLength(0)
    off()
  })
})
