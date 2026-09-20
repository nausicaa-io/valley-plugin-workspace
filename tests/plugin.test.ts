import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1, type DatasetPage, type DatasetQuery } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { register } from '../src/index'
import { React } from '../src/runtime'
import { useWorkspaceSurface } from '../src/surfaces'
import { createStore } from '../src/store'
import { WorkspaceRepository, type SavedLayout } from '../src/repository'
import config from '../config.json'
describe('workspace package', () => { it('registers through its injected API', () => { const mock = createMockValleyApi(); const dispose = register(mock.api); expect(mock.commands.length).toBeGreaterThan(0); dispose?.() }) })

it('awaits queued user changes before unload and retains a failed change for retry', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'workspace', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const store = createStore(mock.api)
  const transact = mock.api.data.transaction
  let finish!: () => void
  const blocked = new Promise<void>((resolve) => { finish = resolve })
  const transaction = vi.spyOn(mock.api.data, 'transaction').mockImplementationOnce(async (...args) => { await blocked; return transact(...args) })
  const first = store.createGroup('Ferns')
  await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(1))
  let completed = false
  const unload = mock.runBeforeUnload().then(() => { completed = true })
  await Promise.resolve()
  expect(completed).toBe(false)
  finish()
  await first
  await unload
  expect(await mock.api.data.dataset('workspace_groups').get({ name: 'Ferns' })).toMatchObject({ name: 'Ferns' })
  transaction.mockRejectedValueOnce(new Error('Disk unavailable'))
  await expect(store.createGroup('Moss')).rejects.toThrow('Disk unavailable')
  await expect(mock.runBeforeUnload()).rejects.toThrow('Disk unavailable')
  expect(store.declaredGroups).toContain('Moss')
  await store.renameGroup('Moss', 'Mosses')
  await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
  expect(await mock.api.data.dataset('workspace_groups').get({ name: 'Mosses' })).toMatchObject({ name: 'Mosses' })
  store.dispose()
})

it('releases mounted and provider subscriptions after the owning session is revoked', () => {
  const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
  const dispose = register(mock.api)
  function Subject(): null {
    useWorkspaceSurface('left_sidebar')
    return null
  }
  const mounted = render(React.createElement(Subject))
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
  const unsubscribe = surface.subscribe(vi.fn())
  const state = mock.api.runtime.getOrCreate('workspace.surfaces', () => ({ listeners: new Set() }))
  expect(state.listeners.size).toBe(2)
  dispose()
  const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => {
    throw new Error('Plugin session is no longer active')
  })
  try {
    unsubscribe()
    mounted.unmount()
    expect(state.listeners.size).toBe(0)
    expect(runtime).not.toHaveBeenCalled()
  } finally {
    runtime.mockRestore()
    mounted.unmount()
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail })
  return { promise, resolve, reject }
}

describe('workspace refresh ownership', () => {
  function setup() {
    const mock = createMockValleyApi({ manifest: { id: 'workspace', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
    const dataset = mock.api.data.dataset
    const query = vi.fn((request) => dataset('workspace_groups').query(request))
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => {
      const handle = dataset(name)
      return name === 'workspace_groups' ? { ...handle, query } : handle
    }) as typeof dataset)
    return { mock, query, store: createStore(mock.api) }
  }

  it('shares initial consumers and merges a pending revision burst before publishing', async () => {
    const { mock, query, store } = setup()
    const firstRead = deferred<DatasetPage>()
    query.mockImplementationOnce(() => firstRead.promise)
    const published: string[][] = []
    store.subscribe(() => published.push([...store.declaredGroups]))
    const first = store.ensureLoaded()
    const second = store.ensureLoaded()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await mock.api.data.dataset('workspace_groups').insert({ name: 'Ferns', position: 0 })
    await mock.api.data.dataset('workspace_groups').insert({ name: 'Mosses', position: 1 })
    for (let n = 0; n < 20; n++) void store.refresh()
    expect(query).toHaveBeenCalledTimes(1)
    firstRead.resolve({ rows: [], revision: 0 })
    await first
    expect(query).toHaveBeenCalledTimes(2)
    expect(published).toEqual([['Ferns', 'Mosses']])
    store.dispose()
  })

  it('allows a failed initial read to be retried', async () => {
    const { query, store } = setup()
    query.mockRejectedValueOnce(new Error('Dataset unavailable'))
    await expect(store.ensureLoaded()).rejects.toThrow('Dataset unavailable')
    await expect(store.ensureLoaded()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('retries a failed stale read when a newer dataset revision is already requested', async () => {
    const { mock, query, store } = setup()
    const firstRead = deferred<DatasetPage>()
    query.mockImplementationOnce(() => firstRead.promise)
    const pending = store.ensureLoaded()
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await mock.api.data.dataset('workspace_groups').insert({ name: 'Ferns', position: 0 })
    firstRead.reject(new Error('Stale read failed'))
    await pending
    expect(store.declaredGroups).toEqual(['Ferns'])
    expect(query).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('does not publish or start a follow-up after disposal', async () => {
    const { query, store } = setup()
    const firstRead = deferred<DatasetPage>()
    query.mockImplementationOnce(() => firstRead.promise)
    const listener = vi.fn()
    store.subscribe(listener)
    const pending = store.ensureLoaded()
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    void store.refresh()
    store.dispose()
    firstRead.resolve({ rows: [{ name: 'Late', position: 0 }], cursor: 'another-page', revision: 1 })
    await pending
    expect(store.declaredGroups).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('preserves local mutations when an older refresh completes during persistence', async () => {
    const { mock, query, store } = setup()
    await store.ensureLoaded()
    const firstRead = deferred<DatasetPage>()
    query.mockImplementationOnce(() => firstRead.promise)
    const refresh = store.refresh()
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    await store.createGroup('Ferns')
    firstRead.resolve({ rows: [], revision: 0 })
    await refresh
    expect(store.declaredGroups).toEqual(['Ferns'])
    expect(await mock.api.data.dataset('workspace_groups').get({ name: 'Ferns' })).toMatchObject({ name: 'Ferns' })
    store.dispose()
  })

  it('persists each accepted change using its captured snapshot while later edits wait', async () => {
    const { mock, query, store } = setup()
    const held = deferred<DatasetPage>()
    query.mockImplementationOnce(() => held.promise)
    const transaction = vi.spyOn(mock.api.data, 'transaction')
    const first = store.createGroup('Ferns')
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    const second = store.createGroup('Mosses')
    held.resolve({ rows: [], revision: 0 })
    await Promise.all([first, second])
    const snapshots = transaction.mock.calls.map(([operations]) => operations.flatMap(operation =>
      operation.dataset === 'workspace_groups' && operation.operation === 'insert'
        ? (Array.isArray(operation.values) ? operation.values : operation.values ? [operation.values] : []).map(row => row.name) : []))
    expect(snapshots).toEqual([['Ferns'], ['Mosses']])
    expect(await mock.api.data.dataset('workspace_groups').count()).toBe(2)
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
    store.dispose()
  })

  it('captures nested layout values and retains an unencodable save failure until repaired', async () => {
    const { mock, query, store } = setup()
    const held = deferred<DatasetPage>()
    query.mockImplementationOnce(() => held.promise)
    const snapshot = mock.api.workspace.captureLayout()
    snapshot.leftSidebarWidth = 240
    const layout = { name: 'Canopy', group: '', snapshot, createdAt: 1, modifiedAt: 1 }
    const saved = store.upsert(layout)
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    snapshot.leftSidebarWidth = 800
    layout.name = 'Moved'
    layout.group = 'Other'
    held.resolve({ rows: [], revision: 0 })
    await saved
    expect(store.find('Canopy')).toMatchObject({ name: 'Canopy', group: '', snapshot: { leftSidebarWidth: 240 } })
    expect(store.find('Moved')).toBeUndefined()
    expect(store.hasGroup('Other')).toBe(false)
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: 'Canopy' })).toMatchObject({ snapshot: { leftSidebarWidth: 240 } })
    const cyclic = { ...snapshot, pluginViewStates: [{ owner: 'fixture', id: 'view', surface: 'left_sidebar' as const, state: {} }] }
    cyclic.pluginViewStates[0].state = cyclic
    await expect(store.upsert({ ...layout, name: 'Canopy', snapshot: cyclic })).rejects.toThrow(/circular/i)
    await expect(mock.runBeforeUnload()).rejects.toThrow(/circular/i)
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: 'Canopy' })).toMatchObject({ snapshot: { leftSidebarWidth: 240 } })
    await store.upsert({ ...layout, name: 'Canopy', snapshot: { ...snapshot, leftSidebarWidth: 360 } })
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: 'Canopy' })).toMatchObject({ snapshot: { leftSidebarWidth: 360 } })
    store.dispose()
  })

  it('settles both accepted dataset reads before a failed save releases the next save', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
    const held = deferred<DatasetPage>()
    const dataset = mock.api.data.dataset
    const query = vi.fn((request) => dataset('workspace_groups').query(request)).mockImplementationOnce(() => held.promise)
    let rejectLayouts = true
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => {
      const handle = dataset(name)
      if (name === 'workspace_groups') return { ...handle, query }
      return name === 'workspace_layouts' && rejectLayouts ? { ...handle, query: async () => {
        rejectLayouts = false
        throw new Error('Fixture layouts unavailable')
      } } : handle
    }) as typeof dataset)
    const store = createStore(mock.api)
    const first = store.createGroup('Ferns')
    const failed = expect(first).rejects.toThrow('Fixture layouts unavailable')
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    const next = store.createGroup('Mosses')
    await Promise.resolve()
    await Promise.resolve()
    expect(query).toHaveBeenCalledTimes(1)
    held.resolve({ rows: [], revision: 0 })
    await failed
    await next
    expect(query).toHaveBeenCalledTimes(2)
    expect(await mock.api.data.dataset('workspace_groups').get({ name: 'Mosses' })).toMatchObject({ name: 'Mosses' })
    await expect(mock.runBeforeUnload()).resolves.toBeUndefined()
    store.dispose()
  })

  it('reuses name and group projections until a layout or group changes', async () => {
    const { mock, store } = setup()
    const readName = vi.fn((index: number) => `Layout ${index}`)
    store.layouts = Array.from({ length: 500 }, (_, index) => ({
      get name() { return readName(index) }, group: 'Ferns', snapshot: mock.api.workspace.captureLayout(), createdAt: 1, modifiedAt: 1
    }))
    store.declaredGroups = ['Empty']
    const groups = store.groups()
    expect(readName).toHaveBeenCalledTimes(500)
    for (let index = 0; index < 100; index++) {
      expect(store.find(` layout ${index} `)).toBe(store.layouts[index])
      expect(store.groups()).toBe(groups)
      expect(store.hasGroup(' FERNS ')).toBe(true)
      expect(store.groupNames()).toEqual(['Empty', 'Ferns'])
    }
    expect(readName).toHaveBeenCalledTimes(500)
    store.layouts = [store.layouts[0]]
    expect(store.find('Layout 499')).toBeUndefined()
    expect(store.groups()).not.toBe(groups)
    expect(store.groups().find(group => group.group === 'Ferns')?.layouts).toHaveLength(1)
    store.declaredGroups = ['Canopy']
    expect(store.hasGroup('Empty')).toBe(false)
    expect(store.groupNames()).toEqual(['Canopy', 'Ferns'])
    store.dispose()
  })

  it.each([999, 1000, 1001])('loads all %i saved groups across page boundaries', async count => {
    const { query, store } = setup()
    const rows = Array.from({ length: count }, (_, position) => ({ name: `Group ${String(position).padStart(4, '0')}`, position }))
    query.mockImplementation(async request => {
      const offset = request.cursor ? Number(request.cursor) : 0
      return { rows: rows.slice(offset, offset + 1000), revision: 1, ...(offset + 1000 < count ? { cursor: String(offset + 1000) } : {}) }
    })
    await store.ensureLoaded()
    expect(store.groupNames()).toEqual(rows.map(row => row.name))
    expect(query).toHaveBeenCalledTimes(Math.ceil(count / 1000))
    store.dispose()
  })
})

describe('workspace keyed persistence', () => {
  function fixture(count: number) {
    const snapshot = createMockValleyApi().api.workspace.captureLayout()
    const layouts: SavedLayout[] = Array.from({ length: count }, (_, index) => ({
      name: `Layout ${String(index).padStart(4, '0')}`, group: 'Ferns', snapshot: structuredClone(snapshot), createdAt: 1, modifiedAt: 1
    }))
    const groups = Array.from({ length: count }, (_, index) => `Group ${String(index).padStart(4, '0')}`)
    const mock = createMockValleyApi({
      manifest: { id: 'workspace', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] },
      datasets: {
        'workspace.workspace_layouts': layouts.map(layout => ({ ...layout, snapshotVersion: 1 })),
        'workspace.workspace_groups': groups.map((name, position) => ({ name, position }))
      }
    })
    const dataset = mock.api.data.dataset
    const queries = vi.fn((name: string, query: DatasetQuery) => dataset(name).query(query))
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(((name: string) => ({
      ...dataset(name), query: (query: DatasetQuery) => queries(name, query)
    })) as typeof dataset)
    const transact = mock.api.data.transaction
    const transaction = vi.spyOn(mock.api.data, 'transaction')
    const notify = vi.fn()
    const repository = new WorkspaceRepository(mock.api, notify)
    return { mock, layouts, groups, transact, transaction, queries, repository, notify }
  }

  it.each([999, 1000, 1001])('writes one layout edit and one case-renamed group among %i rows per dataset', async count => {
    const { mock, layouts, groups, transaction, queries, repository } = fixture(count)
    const last = layouts.at(-1)!
    const edited = layouts.map(layout => layout === last ? { ...layout, group: 'Mosses', modifiedAt: 2 } : layout)
    await repository.save(edited, groups)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction.mock.calls[0][0]).toEqual([{ dataset: 'workspace_layouts', operation: 'update', key: { name: last.name }, values: { group: 'Mosses', modifiedAt: 2 } }])
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: last.name })).toMatchObject({ group: 'Mosses', modifiedAt: 2 })
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: layouts[0].name })).toMatchObject({ group: 'Ferns', modifiedAt: 1 })
    for (const name of ['workspace_layouts', 'workspace_groups']) expect(queries.mock.calls.filter(([dataset]) => dataset === name)).toHaveLength(Math.ceil(count / 1000))
    const renamed = groups.map((name, index) => index === count - 1 ? name.toLowerCase() : name)
    await repository.save(edited, renamed)
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(transaction.mock.calls[1][0]).toEqual([
      { dataset: 'workspace_groups', operation: 'delete', key: { name: groups.at(-1) } },
      { dataset: 'workspace_groups', operation: 'insert', values: { name: renamed.at(-1), position: count - 1 } }
    ])
    expect(await mock.api.data.dataset('workspace_groups').get({ name: groups.at(-1)! })).toBeNull()
    expect(await mock.api.data.dataset('workspace_groups').get({ name: renamed.at(-1)! })).toMatchObject({ position: count - 1 })
    expect(await mock.api.data.dataset('workspace_layouts').count()).toBe(count)
    expect(await mock.api.data.dataset('workspace_groups').count()).toBe(count)
    await repository.save(edited, renamed)
    expect(transaction).toHaveBeenCalledTimes(2)
    for (const name of ['workspace_layouts', 'workspace_groups']) expect(queries.mock.calls.filter(([dataset]) => dataset === name)).toHaveLength(3 * Math.ceil(count / 1000))
    await repository.drain()
  })

  it('skips unchanged rows and JSON object-key ordering without sending an empty transaction', async () => {
    const { layouts, groups, transaction, repository, notify } = fixture(3)
    const reordered = layouts.map(layout => ({ ...layout, snapshot: Object.fromEntries(Object.entries(layout.snapshot).reverse()) as SavedLayout['snapshot'] }))
    await repository.save(reordered, [...groups])
    expect(transaction).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    await repository.drain()
  })

  it('preserves exact case-sensitive primary keys through layout/group rename and deletion', async () => {
    const { mock, layouts, transaction, repository } = fixture(0)
    const snapshot = mock.api.workspace.captureLayout()
    const first = { name: 'Canopy', group: 'Ferns', snapshot, createdAt: 1, modifiedAt: 1 }
    const twin = { ...first, name: 'canopy', group: 'ferns' }
    layouts.push(first, twin)
    await repository.save(layouts, ['Ferns', 'ferns'])
    transaction.mockClear()
    const renamed = { ...first, name: 'CANOPY', group: 'FERNS' }
    await repository.save([renamed, twin], ['FERNS', 'ferns'])
    expect(transaction.mock.calls[0][0]).toEqual([
      { dataset: 'workspace_layouts', operation: 'delete', key: { name: 'Canopy' } },
      { dataset: 'workspace_layouts', operation: 'insert', values: { ...renamed, snapshotVersion: 1 } },
      { dataset: 'workspace_groups', operation: 'delete', key: { name: 'Ferns' } },
      { dataset: 'workspace_groups', operation: 'insert', values: { name: 'FERNS', position: 0 } }
    ])
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: 'canopy' })).toMatchObject(twin)
    await repository.save([twin], ['ferns'])
    expect(transaction.mock.calls[1][0]).toEqual([
      { dataset: 'workspace_layouts', operation: 'delete', key: { name: 'CANOPY' } },
      { dataset: 'workspace_groups', operation: 'delete', key: { name: 'FERNS' } },
      { dataset: 'workspace_groups', operation: 'update', key: { name: 'ferns' }, values: { position: 0 } }
    ])
    expect(await mock.api.data.dataset('workspace_layouts').count()).toBe(1)
    expect(await mock.api.data.dataset('workspace_groups').query()).toMatchObject({ rows: [{ name: 'ferns', position: 0 }] })
  })

  it('persists nested provider values and array ordering while ignoring object-key ordering', async () => {
    const { mock, layouts, groups, transaction, repository } = fixture(1)
    const layout = { ...layouts[0], snapshot: { ...layouts[0].snapshot, pluginViewStates: [{
      owner: 'fixture', id: 'view', surface: 'left_sidebar' as const, state: { enabled: false, paths: ['Canopy.md', 'Ferns.md'] }
    }] } }
    await repository.save([layout], groups)
    transaction.mockClear()
    const reordered = { ...layout, snapshot: { ...layout.snapshot, pluginViewStates: [{
      ...layout.snapshot.pluginViewStates[0], state: { paths: ['Canopy.md', 'Ferns.md'], enabled: false }
    }] } }
    await repository.save([reordered], groups)
    expect(transaction).not.toHaveBeenCalled()
    const edited = { ...reordered, snapshot: { ...reordered.snapshot, pluginViewStates: [{
      ...reordered.snapshot.pluginViewStates[0], state: { paths: ['Ferns.md', 'Canopy.md'], enabled: null }
    }] } }
    await repository.save([edited], groups)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction.mock.calls[0][0]).toEqual([{ dataset: 'workspace_layouts', operation: 'update', key: { name: layout.name }, values: { snapshot: edited.snapshot } }])
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: layout.name })).toMatchObject({ snapshot: edited.snapshot })
  })

  it('retains duplicate-key failures without dropping a row or issuing a partial transaction', async () => {
    const { mock, layouts, groups, transaction, repository } = fixture(1)
    await expect(repository.save([...layouts, layouts[0]], groups)).rejects.toThrow('Duplicate Workspace record name')
    await expect(repository.drain()).rejects.toThrow('Duplicate Workspace record name')
    expect(transaction).not.toHaveBeenCalled()
    expect(await mock.api.data.dataset('workspace_layouts').count()).toBe(1)
    await repository.save(layouts, groups)
    await repository.drain()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('rejects invalid groups before writing a valid layout change or publishing success', async () => {
    const { mock, layouts, groups, transaction, repository, notify } = fixture(1)
    const edited = [{ ...layouts[0], modifiedAt: 2 }]
    await expect(repository.save(edited, [groups[0], groups[0]])).rejects.toThrow('Duplicate Workspace record name')
    await expect(repository.drain()).rejects.toThrow('Duplicate Workspace record name')
    expect(transaction).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(await mock.api.data.dataset('workspace_layouts').get({ name: layouts[0].name })).toMatchObject({ modifiedAt: 1 })
    expect(await mock.api.data.dataset('workspace_groups').query()).toMatchObject({ rows: [{ name: groups[0], position: 0 }] })
    await repository.save(edited, groups)
    await repository.drain()
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction.mock.calls[0][0]).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it.each([999, 1000, 1001])('groups %i changed layouts and deletions into one atomic transaction per save', async count => {
    const { mock, layouts, groups, transact, transaction, repository } = fixture(count)
    transaction.mockImplementation(async (operations, options) => {
      if (operations.length > 1000) throw new Error('Invalid transaction size')
      return transact(operations, options)
    })
    await repository.save(layouts.map(layout => ({ ...layout, modifiedAt: 2 })), groups)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(transaction.mock.calls[0][0]).toEqual([{ dataset: 'workspace_layouts', operation: 'update-many', updates: layouts.map(layout => ({ key: { name: layout.name }, values: { modifiedAt: 2 } })) }])
    expect(await mock.api.data.dataset('workspace_layouts').count({ modifiedAt: 2 })).toBe(count)
    await repository.save([], [])
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(transaction.mock.calls[1][0]).toEqual([
      { dataset: 'workspace_layouts', operation: 'delete-many', keys: layouts.map(layout => ({ name: layout.name })) },
      { dataset: 'workspace_groups', operation: 'delete-many', keys: groups.map(name => ({ name })) }
    ])
    expect(await mock.api.data.dataset('workspace_layouts').count()).toBe(0)
    expect(await mock.api.data.dataset('workspace_groups').count()).toBe(0)
    await repository.save(layouts, groups)
    expect(transaction.mock.calls[2][0]).toHaveLength(2)
    expect(await mock.api.data.dataset('workspace_layouts').count()).toBe(count)
    expect(await mock.api.data.dataset('workspace_groups').count()).toBe(count)
    await repository.drain()
  })

  it('rolls back a failed grouped save and keeps the prior durable layout until a successful retry', async () => {
    const { mock, layouts, groups, transact, transaction, repository } = fixture(1001)
    transaction.mockImplementationOnce((operations, options) => transact([...operations, { dataset: 'workspace_layouts', operation: 'delete-many', keys: [{}] }], options))
    await expect(repository.save(layouts.map(layout => ({ ...layout, modifiedAt: 2 })), groups)).rejects.toThrow('primary key')
    await expect(repository.drain()).rejects.toThrow('primary key')
    expect(transaction).toHaveBeenCalledOnce()
    expect(await mock.api.data.dataset('workspace_layouts').count({ modifiedAt: 1 })).toBe(1001)
    await repository.save(layouts.map(layout => ({ ...layout, modifiedAt: 2 })), groups)
    await repository.drain()
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(await mock.api.data.dataset('workspace_layouts').count({ modifiedAt: 2 })).toBe(1001)
  })
})
