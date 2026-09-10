import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { register } from '../src/index'
import { React } from '../src/runtime'
import { useWorkspaceSurface } from '../src/surfaces'
import { createStore } from '../src/store'
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
