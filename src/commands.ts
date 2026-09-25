/**
 * The Workspace plugin's command-bus surface: typed `workspace:*` commands that
 * save / load / list / rename / delete named layouts (plus `open`/`close` aliases
 * for load/delete, and a palette-safe `save-active` that re-saves the active
 * layout with no name), and the matching `group-*` set that creates, renames,
 * deletes and lists groups — including empty ones, which is why creating a group
 * needs no layout. They drive the same window-anchored store the panel uses,
 * so ⌘P, the terminal CLI (`valley workspace <sub>`), the hotkey map and the
 * assistant all stay in sync. Write commands return a `revert` so the bus owns one
 * ⌘Z entry each.
 */
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { getStore, scopesOf, type SavedLayout, type WorkspaceStore } from './store'
import { openManager } from './surfaces'

function live(): WorkspaceStore {
  const store = getStore()
  if (!store) throw new Error('Workspace store is not ready.')
  return store
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const asBool = (v: unknown): boolean | undefined =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined
const ALL_SCOPES = { rightSidebar: true, iconRail: true, footer: true }
const LABEL_KEYS: Record<string, string> = {
  load: 'auto.2083a7975446',
  open: 'auto.35186cddddda',
  delete: 'auto.fcabbd9c3676',
  close: 'auto.8b50a28bc4f2'
}

interface NamedInput {
  name: string
  group?: string
}
interface SaveInput extends NamedInput {
  rightSidebar?: boolean
  iconRail?: boolean
  footer?: boolean
}
interface RenameInput {
  name: string
  to: string
}
interface SaveResult {
  name: string
  group: string
}
interface ListResult {
  active: string | null
  layouts: { name: string; group: string }[]
}
interface GroupInput {
  name: string
}
interface GroupsResult {
  groups: { name: string; layouts: number }[]
}

/** Re-insert a removed/overwritten layout (or drop a new one) and restore the prior active name. */
function restoreLayout(store: WorkspaceStore, prior: SavedLayout | undefined, priorActive: string | null, created?: string) {
  return async (): Promise<void> => {
    if (prior) await store.upsert(prior)
    else if (created) await store.deleteByName(created)
    await store.setActive(priorActive)
  }
}

export function registerWorkspaceCommands(api: ValleyPluginApi): () => void {
  const revision = async () => { const store = live(); await store.ensureLoaded(); return { layouts: store.layouts, active: store.active, groups: store.groups() } }
  /** Capture the current arrangement under `name` (overwrites + activates). */
  const saveNamed = api.commands.register<SaveInput, SaveResult, 'write'>({
    id: 'save',
    label: 'Workspace: Save current layout as…', labelKey: 'auto.c8227a6250a2',
    paletteSafe: false,
    sideEffect: 'write',
    revision,
    input: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          group: { type: 'string' },
          rightSidebar: { type: 'boolean' },
          iconRail: { type: 'boolean' },
          footer: { type: 'boolean' }
        },
        required: ['name'],
        additionalProperties: false
      },
      parse: (raw) => {
        const o = (raw ?? {}) as Record<string, unknown>
        const name = asStr(o.name).trim()
        if (!name) throw new Error('Usage: workspace save "<name>" [--group "<group>"] [--right-sidebar] [--icon-rail] [--footer]')
        return { name, group: asStr(o.group).trim(), rightSidebar: asBool(o.rightSidebar), iconRail: asBool(o.iconRail), footer: asBool(o.footer) }
      },
      fromCli: (args, flags) => ({
        name: args.join(' ').trim(),
        group: asStr(flags.group).trim(),
        rightSidebar: asBool(flags['right-sidebar']),
        iconRail: asBool(flags['icon-rail']),
        footer: asBool(flags.footer)
      })
    },
    run: async ({ name, group, rightSidebar, iconRail, footer }) => {
      const store = live()
      await store.ensureLoaded()
      const prior = store.find(name)
      const priorActive = store.active
      // Parts the caller leaves out keep the layout's own choice, or the
      // settings' defaults for a new layout.
      const base = prior ? scopesOf(prior.snapshot) : store.defaultScopes()
      const layout = await store.saveCurrent(name, group, {
        rightSidebar: rightSidebar ?? base.rightSidebar,
        iconRail: iconRail ?? base.iconRail,
        footer: footer ?? base.footer
      })
      return {
        value: { name: layout.name, group: layout.group },
        revert: {
          label: `Save layout "${layout.name}"`,
          run: restoreLayout(store, prior, priorActive, layout.name)
        }
      }
    },
    formatCli: (v) => `Saved layout "${v.name}"${v.group ? ` in group "${v.group}"` : ''}.`
  })

  // A palette-safe, no-argument "save what I have now": re-capture the active
  // layout with its own parts (the footer Save button does the same). With no
  // active layout there's nothing to overwrite, so open the manager to name one.
  const saveActive = api.commands.register<void, { name: string | null }, 'write'>({
    id: 'save-active',
    label: 'Workspace: Save current layout', labelKey: 'auto.2db7866c659c',
    paletteSafe: true,
    agentVisibility: 'forbidden',
    sideEffect: 'write',
    revision,
    run: async () => {
      const store = live()
      await store.ensureLoaded()
      const active = store.active ? store.find(store.active) : undefined
      if (!active) {
        if (!openManager('save')) api.workspace.revealOwnPanel('left_sidebar')
        return { value: { name: null }, revert: null }
      }
      const prior = active
      const priorActive = store.active
      await store.replaceWithCurrent(active.name)
      return {
        value: { name: active.name },
        revert: { label: `Save layout "${active.name}"`, run: restoreLayout(store, prior, priorActive) }
      }
    },
    formatCli: (v) => (v.name ? `Saved layout "${v.name}".` : 'Open the workspace manager to name a layout.')
  })

  /** load / open share one body — "open" reads more naturally on the CLI. */
  const loadCommand = (id: string, verb: string) =>
    api.commands.register<NamedInput, { name: string }, 'write'>({
      id,
      label: `Workspace: ${verb[0].toUpperCase()}${verb.slice(1)} a saved layout`,
      labelKey: LABEL_KEYS[id],
      paletteSafe: false,
      sideEffect: 'write',
    revision,
      input: {
        schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
        parse: (raw) => {
          const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
          if (!name) throw new Error(`Usage: workspace ${verb} "<name>"`)
          return { name }
        },
        fromCli: (args) => ({ name: args.join(' ').trim() })
      },
      run: async ({ name }) => {
        const store = live()
        await store.ensureLoaded()
        const target = store.find(name)
        if (!target) throw new Error(`No saved layout named "${name}".`)
        // Undo restores every part a layout may carry, whatever this one saved.
        const priorSnapshot: WorkspaceLayoutSnapshot = store.capture(ALL_SCOPES)
        const priorActive = store.active
        store.applySnapshot(target.snapshot)
        await store.setActive(target.name)
        return {
          value: { name: target.name },
          revert: {
            label: `Load layout "${target.name}"`,
            run: async () => {
              store.applySnapshot(priorSnapshot)
              await store.setActive(priorActive)
            }
          }
        }
      },
      formatCli: (v) => `Loaded layout "${v.name}".`
    })

  /** delete / close share one body — "close" reads more naturally on the CLI. */
  const deleteCommand = (id: string, verb: string) =>
    api.commands.register<NamedInput, { name: string }, 'write'>({
      id,
      label: `Workspace: ${verb[0].toUpperCase()}${verb.slice(1)} a saved layout`,
      labelKey: LABEL_KEYS[id],
      paletteSafe: false,
      sideEffect: 'write',
    revision,
      input: {
        schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
        parse: (raw) => {
          const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
          if (!name) throw new Error(`Usage: workspace ${verb} "<name>"`)
          return { name }
        },
        fromCli: (args) => ({ name: args.join(' ').trim() })
      },
      run: async ({ name }) => {
        const store = live()
        await store.ensureLoaded()
        const target = store.find(name)
        if (!target) throw new Error(`No saved layout named "${name}".`)
        const priorActive = store.active
        await store.deleteByName(target.name)
        return {
          value: { name: target.name },
          revert: {
            label: `Delete layout "${target.name}"`,
            run: restoreLayout(store, target, priorActive)
          }
        }
      },
      formatCli: (v) => `Deleted layout "${v.name}".`
    })

  const renameCommand = api.commands.register<RenameInput, { from: string; to: string }, 'write'>({
    id: 'rename',
    label: 'Workspace: Rename a saved layout', labelKey: 'auto.7a56df30a071',
    paletteSafe: false,
    sideEffect: 'write',
    revision,
    input: {
      schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }, required: ['name', 'to'], additionalProperties: false },
      parse: (raw) => {
        const o = (raw ?? {}) as Record<string, unknown>
        const name = asStr(o.name).trim()
        const to = asStr(o.to).trim()
        if (!name || !to) throw new Error('Usage: workspace rename "<old>" --to "<new>"')
        return { name, to }
      },
      // `workspace rename "<old>" --to "<new>"` or `workspace rename "<old>" "<new>"`.
      fromCli: (args, flags) => ({
        name: asStr(args[0]).trim(),
        to: (asStr(flags.to) || args.slice(1).join(' ')).trim()
      })
    },
    run: async ({ name, to }) => {
      const store = live()
      await store.ensureLoaded()
      const prior = await store.renameByName(name, to)
      return {
        value: { from: prior.name, to },
        revert: {
          label: `Rename layout to "${to}"`,
          run: async () => {
            await store.renameByName(to, prior.name)
          }
        }
      }
    },
    formatCli: (v) => `Renamed layout "${v.from}" → "${v.to}".`
  })

  const list = api.commands.register<void, ListResult, 'read'>({
    id: 'list',
    label: 'Workspace: List saved layouts', labelKey: 'auto.896eeb444cb8',
    paletteSafe: false,
    sideEffect: 'read',
    run: async () => {
      const store = live()
      await store.ensureLoaded()
      return {
        active: store.active,
        layouts: store.layouts.map((l) => ({ name: l.name, group: l.group }))
      }
    },
    formatCli: (v) => {
      if (v.layouts.length === 0) return 'No saved layouts.'
      const lines = v.layouts.map((l) => {
        const tags = [l.group ? `[${l.group}]` : '', l.name === v.active ? '(active)' : '']
          .filter(Boolean)
          .join(' ')
        return `  ${l.name}${tags ? `  ${tags}` : ''}`
      })
      return [`${v.layouts.length} saved layout${v.layouts.length === 1 ? '' : 's'}:`, ...lines].join('\n')
    }
  })

  // Clear the ACTIVE pointer so no saved layout is selected (the live arrangement
  // is left untouched). No-op when nothing is active.
  const deselect = api.commands.register<void, { name: string | null }, 'write'>({
    id: 'deselect',
    label: 'Workspace: Deselect active layout', labelKey: 'auto.60d3a2f4832a',
    paletteSafe: true,
    sideEffect: 'write',
    revision,
    agentVisibility: 'forbidden',
    run: async () => {
      const store = live()
      await store.ensureLoaded()
      const priorActive = store.active
      if (priorActive == null) return { value: { name: null }, revert: null }
      await store.setActive(null)
      return {
        value: { name: priorActive },
        revert: {
          label: 'Deselect active layout',
          run: async () => {
            await store.setActive(priorActive)
          }
        }
      }
    },
    formatCli: (v) => (v.name ? `Deselected active layout "${v.name}".` : 'No active layout to deselect.')
  })

  /** Create an empty group — no layout involved (the panel's folder button). */
  const groupCreate = api.commands.register<GroupInput, { name: string }, 'write'>({
    id: 'group-create',
    label: 'Workspace: New layout group', labelKey: 'auto.cca7f8a201e0',
    paletteSafe: false,
    sideEffect: 'write',
    revision,
    input: {
      schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
      parse: (raw) => {
        const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
        if (!name) throw new Error('Usage: workspace group-create "<group>"')
        return { name }
      },
      fromCli: (args) => ({ name: args.join(' ').trim() })
    },
    run: async ({ name }) => {
      const store = live()
      await store.ensureLoaded()
      const created = await store.createGroup(name)
      return {
        value: { name: created },
        revert: {
          label: `Create group "${created}"`,
          run: async () => {
            await store.deleteGroup(created)
          }
        }
      }
    },
    formatCli: (v) => `Created group "${v.name}".`
  })

  const groupRename = api.commands.register<RenameInput, { from: string; to: string }, 'write'>({
    id: 'group-rename',
    label: 'Workspace: Rename a layout group', labelKey: 'auto.c28c3c2b1a0d',
    paletteSafe: false,
    sideEffect: 'write',
    revision,
    input: {
      schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } }, required: ['name', 'to'], additionalProperties: false },
      parse: (raw) => {
        const o = (raw ?? {}) as Record<string, unknown>
        const name = asStr(o.name).trim()
        const to = asStr(o.to).trim()
        if (!name || !to) throw new Error('Usage: workspace group-rename "<old>" --to "<new>"')
        return { name, to }
      },
      fromCli: (args, flags) => ({
        name: asStr(args[0]).trim(),
        to: (asStr(flags.to) || args.slice(1).join(' ')).trim()
      })
    },
    run: async ({ name, to }) => {
      const store = live()
      await store.ensureLoaded()
      if (!store.hasGroup(name)) throw new Error(`No group named "${name}".`)
      await store.renameGroup(name, to)
      return {
        value: { from: name, to },
        revert: {
          label: `Rename group to "${to}"`,
          run: async () => {
            await store.renameGroup(to, name)
          }
        }
      }
    },
    formatCli: (v) => `Renamed group "${v.from}" → "${v.to}".`
  })

  /** Drop a group; its layouts survive as ungrouped (and the revert puts them back). */
  const groupDelete = api.commands.register<GroupInput, { name: string; layouts: number }, 'write'>({
    id: 'group-delete',
    label: 'Workspace: Delete a layout group', labelKey: 'auto.be1a9fa728a4',
    paletteSafe: false,
    sideEffect: 'write',
    revision,
    input: {
      schema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
      parse: (raw) => {
        const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
        if (!name) throw new Error('Usage: workspace group-delete "<group>"')
        return { name }
      },
      fromCli: (args) => ({ name: args.join(' ').trim() })
    },
    run: async ({ name }) => {
      const store = live()
      await store.ensureLoaded()
      const group = store.groups().find((g) => g.group.toLowerCase() === name.toLowerCase())?.group
      if (!group) throw new Error(`No group named "${name}".`)
      const members = await store.deleteGroup(group)
      return {
        value: { name: group, layouts: members.length },
        revert: {
          label: `Delete group "${group}"`,
          run: async () => {
            await store.createGroup(group)
            await store.assignGroup(members, group)
          }
        }
      }
    },
    formatCli: (v) =>
      v.layouts === 0
        ? `Deleted group "${v.name}".`
        : `Deleted group "${v.name}" — ${v.layouts} layout${v.layouts === 1 ? '' : 's'} moved to Ungrouped.`
  })

  const groups = api.commands.register<void, GroupsResult, 'read'>({
    id: 'groups',
    label: 'Workspace: List layout groups', labelKey: 'auto.20d801545428',
    paletteSafe: false,
    sideEffect: 'read',
    run: async () => {
      const store = live()
      await store.ensureLoaded()
      return {
        groups: store
          .groups()
          .filter((g) => g.group !== '')
          .map((g) => ({ name: g.group, layouts: g.layouts.length }))
      }
    },
    formatCli: (v) => {
      if (v.groups.length === 0) return 'No groups.'
      const lines = v.groups.map((g) => `  ${g.name}  (${g.layouts})`)
      return [`${v.groups.length} group${v.groups.length === 1 ? '' : 's'}:`, ...lines].join('\n')
    }
  })

  const manage = api.commands.register({
    id: 'manage',
    label: 'Workspace: Manage workspace layouts', labelKey: 'auto.24c9b9b89804',
    sideEffect: 'read',
    run: () => {
      // The manager lives behind the footer chip; with that chip hidden, the
      // sidebar panel is the place that can still manage layouts.
      if (!openManager('search')) api.workspace.revealOwnPanel('left_sidebar')
      return undefined
    }
  })

  const offs = [
    saveNamed,
    saveActive,
    loadCommand('load', 'load'),
    loadCommand('open', 'open'),
    deleteCommand('delete', 'delete'),
    deleteCommand('close', 'close'),
    renameCommand,
    list,
    deselect,
    groupCreate,
    groupRename,
    groupDelete,
    groups,
    manage
  ]

  return () => offs.forEach((off) => off())
}
