/**
 * Built-in Workspace plugin — Obsidian-style saved layouts.
 *
 * A left-sidebar panel ("Workspace layouts") lets you save the current
 * arrangement (pane/tab tree, left sidebar and selected panel, plus configured
 * optional rails/right-sidebar scopes) under a name, load it back, organize layouts into groups, rename and
 * delete them — with an `ACTIVE`
 * badge on the layout you last saved/loaded. Groups are first-class: naming an
 * unknown group in the save field creates it on the spot, with no layout in it
 * (see `store.ts` for how an empty group is persisted). A group header carries
 * no buttons of its own — right-click renames or deletes it, double-clicking its
 * name renames in place. Each row is a single click-to-load line; a `⋯` overflow
 * menu holds Rename / Move to Group / Save changes / Delete so the row never
 * gets crowded. A footer chip mirrors which layout is active
 * with a one-tap save, and opens the full manager (`ManageModal.tsx`).
 * The same actions are exposed on the command bus (`workspace:save/save-active/
 * load/open/rename/close/delete/list`, plus `valley workspace <sub>` in the
 * terminal CLI) so layouts work from ⌘P, hotkeys and the assistant too.
 *
 * It uses the host's React (`./runtime`) and never imports `react`, so the bundle
 * has zero bare imports; all UI is inline elements + inline styles keyed off the
 * real design tokens (`--container-color`, `--surface-color`, `--border-light`,
 * `--text-color`/`--text-secondary`, `--hover-bg`, `--accent-color`,
 * `--accent-tint-bg`/`--accent-tint-text`) so it renders under both themes.
 * Group picking is the host's `api.ui.ComboField` — never a `<datalist>` or a
 * hand-rolled positioned menu.
 */
import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { registerWorkspaceCommands } from './commands'
import { createStore, getStore, type SavedLayout } from './store'
import { initLocalization } from './localization'
import { uiText } from './localization'
import { initRuntime, React } from './runtime'
import { ManageModal } from './ManageModal'
import { patchWorkspaceSurface, registerWorkspaceSurfaces, useWorkspaceSurface } from './surfaces'
import {
  checkmarkDoneIcon,
  chevronDownIcon,
  chevronRightIcon,
  clearIcon,
  deselectIcon,
  folderIcon,
  saveIcon,
  searchIcon
} from './icons'
import { SANS, ago, fieldStyle, groupField, openGroupMenu, openLayoutMenu, pill } from './ui'

const LAYOUT_DND_TYPE = 'application/x-valley-workspace-layout'

type LayoutDragEvent = {
  dataTransfer: {
    effectAllowed?: string
    dropEffect?: string
    setData: (type: string, value: string) => void
    getData: (type: string) => string
  }
  preventDefault: () => void
}

export function register(api: ValleyPluginApi): () => void {
  initLocalization(api)
  initRuntime(api)
  const h = React.createElement
  const store = createStore(api)
  void store.ensureLoaded()

  // ── Footer chip: active layout name + the manage modal ─────────────────────
  // The label opens the manager. The icon saves directly through the store so a
  // user click never becomes a plugin-originated Guard command.
  const FooterItem = (): ReturnType<typeof h> | null => {
    const [, force] = React.useState(0)
    const { managerOpen: switcherOpen } = useWorkspaceSurface('footer')
    const setSwitcherOpen = (managerOpen: boolean): void => patchWorkspaceSurface('footer', { managerOpen })
    const [switcherFocus, setSwitcherFocus] = React.useState<'search' | 'save'>('search')
    React.useEffect(() => {
      const s = getStore()
      void s?.ensureLoaded()
      const bump = (): void => force((n) => n + 1)
      const offStore = s?.subscribe(bump)
      const offState = api.subscribe(bump)
      return () => {
        offStore?.()
        offState()
      }
    }, [])

    const s = getStore()
    if (!s) return null
    const activeLayout = s.active ? (s.find(s.active) ?? null) : null
    const activeName = activeLayout?.name ?? null
    const saved = !!activeLayout && s.isCurrent(activeLayout.snapshot)

    const closeSwitcher = (): void => {
      setSwitcherOpen(false)
      setSwitcherFocus('search')
    }

    const saveFromFooter = (): void => {
      if (!activeLayout) {
        setSwitcherFocus('save')
        setSwitcherOpen(true)
        return
      }
      void s.saveCurrent(activeLayout.name, activeLayout.group).catch(() => undefined)
    }

    const switcher = switcherOpen
      ? h(
          api.ui.Modal,
          {
            title: uiText('auto.3ab6bff19b6d'),
            size: 'wide',
            onClose: closeSwitcher
          },
          h(ManageModal, { onClose: closeSwitcher, initialFocus: switcherFocus })
        )
      : null

    return h(
      React.Fragment,
      null,
      h(
        'div',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } },
        h(
          'button',
          {
            title: uiText('auto.3ab6bff19b6d'),
            onClick: () => {
              setSwitcherFocus('search')
              setSwitcherOpen(true)
            },
            style: {
              fontFamily: SANS,
              fontSize: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--statusbar-text)',
              borderRadius: '6px',
              lineHeight: 1.2,
              padding: '1px 7px'
            },
            onMouseEnter: (e: { currentTarget: HTMLElement }) => {
              e.currentTarget.style.background = 'var(--hover-bg)'
              e.currentTarget.style.color = 'var(--title-color)'
            },
            onMouseLeave: (e: { currentTarget: HTMLElement }) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = 'var(--statusbar-text)'
            }
          },
          h(
            'span',
            { style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            activeName ?? uiText('auto.4ca0a75c2b7f')
          )
        ),
        h(
          'button',
          {
            title: saved ? uiText('auto.b2e0cfe57e87') : uiText('auto.aa4b0670d981'),
            'aria-label': saved ? uiText('auto.b2e0cfe57e87') : uiText('auto.aa4b0670d981'),
            onClick: saveFromFooter,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '18px',
              height: '18px',
              border: 'none',
              background: 'transparent',
              color: 'var(--statusbar-text)',
              cursor: 'pointer',
              borderRadius: '6px',
              padding: 0
            },
            onMouseEnter: (e: { currentTarget: HTMLElement }) => {
              e.currentTarget.style.background = 'var(--hover-bg)'
              e.currentTarget.style.color = 'var(--title-color)'
            },
            onMouseLeave: (e: { currentTarget: HTMLElement }) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = 'var(--statusbar-text)'
            }
          },
          saved ? checkmarkDoneIcon(13) : saveIcon(13)
        )
      ),
      switcher
    )
  }

  // ── Left-sidebar panel ──────────────────────────────────────────────────
  const Panel = (): ReturnType<typeof h> => {
    const [, force] = React.useState(0)
    const [name, setName] = React.useState('')
    const [group, setGroup] = React.useState('')
    const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
    const [renaming, setRenaming] = React.useState<string | null>(null)
    const [renameDraft, setRenameDraft] = React.useState('')
    const [groupRenaming, setGroupRenaming] = React.useState<string | null>(null)
    const [groupRenameDraft, setGroupRenameDraft] = React.useState('')
    const { query } = useWorkspaceSurface('left_sidebar')
    const setQuery = (query: string): void => patchWorkspaceSurface('left_sidebar', { query })
    const [draggedLayout, setDraggedLayout] = React.useState<string | null>(null)
    const [dropGroup, setDropGroup] = React.useState<string | null>(null)
    const panelRef = React.useRef<HTMLDivElement>(null)

    React.useEffect(() => {
      const s = getStore()
      void s?.ensureLoaded()
      const bump = (): void => force((n) => n + 1)
      const offStore = s?.subscribe(bump)
      const offState = api.subscribe(bump)
      return () => {
        offStore?.()
        offState()
      }
      // `api` is a stable injected SDK singleton (outer scope), not a reactive dep.
    }, [])

    // Close an inline rename on Escape.
    React.useEffect(() => {
      if (renaming === null) return
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setRenaming(null)
      }
      const window = panelRef.current?.ownerDocument.defaultView
      window?.addEventListener('keydown', onKey)
      return () => window?.removeEventListener('keydown', onKey)
    }, [renaming])

    // Close an inline group rename on Escape.
    React.useEffect(() => {
      if (groupRenaming === null) return
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setGroupRenaming(null)
      }
      const window = panelRef.current?.ownerDocument.defaultView
      window?.addEventListener('keydown', onKey)
      return () => window?.removeEventListener('keydown', onKey)
    }, [groupRenaming])

    const s = getStore()
    const active = s?.active ?? null
    const groups = s?.groups() ?? []
    const showGroupHeaders = groups.length > 1 || (groups[0]?.group ?? '') !== ''

    const doSave = (): void => {
      const trimmed = name.trim()
      if (!trimmed || !s) return
      void s.saveCurrent(trimmed, group.trim())
      setName('')
      setGroup('')
    }

    // Typing a name the save field's dropdown doesn't know creates that group
    // right away — the group exists (and is listed, and can be dropped onto)
    // whether or not a layout is ever saved into it.
    const chooseGroup = (next: string): void => {
      setGroup(next)
      const trimmed = next.trim()
      if (!trimmed || !s || s.hasGroup(trimmed)) return
      void s.createGroup(trimmed).catch(() => undefined)
    }


    const startRename = (layout: SavedLayout): void => {
      setRenameDraft(layout.name)
      setRenaming(layout.name)
    }

    const commitRename = (oldName: string): void => {
      const next = renameDraft.trim()
      setRenaming(null)
      if (!s || !next || next === oldName) return
      void s.renameByName(oldName, next).catch(() => undefined)
    }

    const startGroupRename = (groupKey: string): void => {
      setGroupRenameDraft(groupKey)
      setGroupRenaming(groupKey)
    }

    const commitGroupRename = (oldGroup: string): void => {
      const next = groupRenameDraft.trim()
      setGroupRenaming(null)
      if (!s || !next || next === oldGroup) return
      void s.renameGroup(oldGroup, next).catch(() => undefined)
    }

    const input = (
      value: string,
      onInput: (v: string) => void,
      placeholder: string,
      onEnter?: () => void
    ): ReturnType<typeof h> =>
      h('input', {
        value,
        placeholder,
        spellCheck: false,
        onChange: (e: { target: { value: string } }) => onInput(e.target.value),
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault()
            onEnter()
          }
        },
        style: fieldStyle
      })

    /** One menu for both entry points: the `⋯` button and a row right-click. */
    const openRowMenu = (layout: SavedLayout, target: HTMLElement | { x: number; y: number }): void => {
      patchWorkspaceSurface('left_sidebar', { selected: layout.name })
      openLayoutMenu(layout, target, { onRename: () => startRename(layout) })
    }

    /** Rename / delete for a group, from a right-click on its header. */
    const openHeaderMenu = (groupKey: string, target: HTMLElement | { x: number; y: number }): void =>
      openGroupMenu(groupKey, target, { onRename: () => startGroupRename(groupKey) })

    const row = (layout: SavedLayout): ReturnType<typeof h> => {
      const isActive = active != null && layout.name.toLowerCase() === active.toLowerCase()
      const isRenaming = renaming === layout.name
      const inert = isRenaming
      const nameEl = isRenaming
        ? h('input', {
            value: renameDraft,
            autoFocus: true,
            spellCheck: false,
            onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
            onChange: (e: { target: { value: string } }) => setRenameDraft(e.target.value),
            onBlur: () => commitRename(layout.name),
            onKeyDown: (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename(layout.name)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(null)
              }
            },
            style: { ...fieldStyle, padding: '3px 6px', fontSize: '0.8125rem', fontWeight: 600 }
          })
        : h(
            'span',
            {
              style: {
                fontFamily: SANS,
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: 'var(--text-color)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }
            },
            layout.name
          )

      return h(
        'div',
        {
          key: layout.name,
          'data-layout-name': layout.name,
          'data-testid': `workspace-layout-${layout.name}`,
          draggable: !inert,
          title: inert ? undefined : uiText('auto.116ebc27f2e5', { p0: layout.name }),
          onClick: inert ? undefined : () => { patchWorkspaceSurface('left_sidebar', { selected: layout.name }); void s?.loadByName(layout.name) },
          // Right-click opens the same menu as `⋯`, at the pointer.
          onContextMenu: inert
            ? undefined
            : (e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }) => {
                e.preventDefault()
                e.stopPropagation()
                openRowMenu(layout, { x: e.clientX, y: e.clientY })
              },
          onDragStart: (e: LayoutDragEvent) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(LAYOUT_DND_TYPE, layout.name)
            e.dataTransfer.setData('text/plain', layout.name)
            setDraggedLayout(layout.name)
          },
          onDragEnd: () => {
            setDraggedLayout(null)
            setDropGroup(null)
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '7px 8px',
            borderRadius: '6px',
            cursor: inert ? 'default' : 'pointer'
          },
          onMouseEnter: (e: { currentTarget: HTMLElement }) => {
            if (!inert) e.currentTarget.style.background = 'var(--hover-bg)'
          },
          onMouseLeave: (e: { currentTarget: HTMLElement }) => {
            e.currentTarget.style.background = 'transparent'
          }
        },
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
            nameEl,
            isActive ? pill(uiText('auto.a733b809d2f1')) : null
            // No group chip here: every panel row already sits under its group
            // header, and the narrow sidebar has no room to say it twice.
          ),
          isRenaming
            ? null
            : h(
                'div',
                { style: { fontFamily: SANS, fontSize: '0.6875rem', color: 'var(--text-secondary)' } },
                ago(layout.modifiedAt)
              )
        ),
        inert
          ? null
          : h(
              'button',
              {
                title: uiText('auto.a1e34f91579d'),
                'aria-label': uiText('auto.f3e477e6f573', { p0: layout.name }),
                onClick: (e: { currentTarget: HTMLElement; stopPropagation: () => void }) => {
                  e.stopPropagation()
                  openRowMenu(layout, e.currentTarget)
                },
                style: {
                  fontFamily: SANS,
                  fontSize: '1rem',
                  lineHeight: 1,
                  width: '26px',
                  height: '26px',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  background: 'transparent',
                  border: '1px solid transparent'
                }
              },
              '⋯'
            )
      )
    }

    const groupBlock = (g: { group: string; layouts: SavedLayout[] }, forceOpen: boolean): ReturnType<typeof h> => {
      const label = g.group || uiText('auto.a7746fee0fd8')
      const groupKey = g.group.trim()
      const isCollapsed = !forceOpen && collapsed[label] === true
      const isRenamingGroup = groupKey !== '' && groupRenaming === groupKey
      const labelEl = isRenamingGroup
        ? h('input', {
            value: groupRenameDraft,
            autoFocus: true,
            spellCheck: false,
            onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
            onChange: (e: { target: { value: string } }) => setGroupRenameDraft(e.target.value),
            onBlur: () => commitGroupRename(groupKey),
            onKeyDown: (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                commitGroupRename(groupKey)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setGroupRenaming(null)
              }
            },
            style: {
              ...fieldStyle,
              flex: 1,
              padding: '2px 6px',
              fontSize: '0.6875rem',
              fontWeight: 700,
              letterSpacing: '0.03em',
              textTransform: 'uppercase'
            }
          })
        : h(
            'span',
            {
              style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              onDoubleClick:
                groupKey !== ''
                  ? (e: { stopPropagation: () => void }) => {
                      e.stopPropagation()
                      startGroupRename(groupKey)
                    }
                  : undefined
            },
            label
          )
      // The header is just the collapse button — no `⋯`: right-click opens the
      // group menu and a double-click on the name renames it in place.
      const header = showGroupHeaders
        ? h(
            'button',
            {
              key: `h-${label}`,
              onClick: () => setCollapsed((prev) => ({ ...prev, [label]: !prev[label] })),
              onContextMenu: (e: {
                preventDefault: () => void
                stopPropagation: () => void
                clientX: number
                clientY: number
              }) => {
                if (isRenamingGroup) return
                e.preventDefault()
                e.stopPropagation()
                openHeaderMenu(groupKey, { x: e.clientX, y: e.clientY })
              },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                width: '100%',
                padding: '6px 6px',
                marginTop: '2px',
                borderRadius: '6px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: SANS,
                fontSize: '0.6875rem',
                fontWeight: 700,
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)'
              },
              onMouseEnter: (e: { currentTarget: HTMLElement }) => {
                e.currentTarget.style.background = 'var(--hover-bg)'
                e.currentTarget.style.color = 'var(--text-color)'
              },
              onMouseLeave: (e: { currentTarget: HTMLElement }) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'var(--text-secondary)'
              }
            },
            isCollapsed ? chevronRightIcon() : chevronDownIcon(),
            folderIcon(),
            labelEl,
            h(
              'span',
              { style: { fontWeight: 500, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' } },
              `${g.layouts.length}`
            )
          )
        : null
      // An empty group is a real place you can drop into — say so, so it never
      // reads as a rendering glitch.
      const emptyHint =
        g.layouts.length === 0
          ? h(
              'div',
              {
                key: `e-${label}`,
                style: {
                  fontFamily: SANS,
                  fontSize: '0.6875rem',
                  color: 'var(--text-tertiary)',
                  padding: '4px 8px 8px 25px'
                }
              },
              uiText('auto.3e50062d85cc')
            )
          : null
      const dropTarget = draggedLayout !== null && dropGroup === groupKey
      const acceptDrop = (e: LayoutDragEvent): void => {
        if (!draggedLayout && !e.dataTransfer.getData(LAYOUT_DND_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropGroup(groupKey)
      }
      const receiveDrop = (e: LayoutDragEvent): void => {
        e.preventDefault()
        const source = e.dataTransfer.getData(LAYOUT_DND_TYPE) || draggedLayout
        setDraggedLayout(null)
        setDropGroup(null)
        if (!source || !s) return
        void s.setGroup(source, groupKey).catch(() => undefined)
      }
      return h(
        'div',
        {
          key: `g-${label}`,
          'data-group-name': groupKey,
          'data-testid': `workspace-group-${groupKey || 'ungrouped'}`,
          onDragOver: acceptDrop,
          onDrop: receiveDrop,
          style: {
            borderRadius: '7px',
            background: dropTarget ? 'var(--accent-tint-bg)' : 'transparent',
            transition: 'background 100ms ease'
          }
        },
        header,
        isCollapsed ? null : g.layouts.map(row),
        isCollapsed ? null : emptyHint
      )
    }

    // Search filters the saved-layout list by name or group; group headers stay
    // visible (so matches keep their context) and force-expand while searching.
    // A group whose *name* matches keeps all of its rows — and shows up even
    // with none, so an empty group is still findable.
    const q = query.trim().toLowerCase()
    const searching = q.length > 0
    const matchesQuery = (l: SavedLayout): boolean =>
      l.name.toLowerCase().includes(q) || l.group.toLowerCase().includes(q)
    const groupMatches = (group: string): boolean => group !== '' && group.toLowerCase().includes(q)
    const visibleGroups = searching
      ? groups
          .map((g) => (groupMatches(g.group) ? g : { group: g.group, layouts: g.layouts.filter(matchesQuery) }))
          .filter((g) => g.layouts.length > 0 || groupMatches(g.group))
      : groups
    const noMatches = searching && visibleGroups.length === 0

    const searchBar = h(
      'div',
      {
        key: 'search-bar',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          margin: '0 3px 6px',
          padding: '6px 9px',
          border: '1px solid var(--border-light)',
          borderRadius: '6px',
          background: 'var(--container-color-alt)'
        }
      },
      searchIcon(13),
      h('input', {
        value: query,
        placeholder: uiText('auto.03a5e4943986'),
        spellCheck: false,
        onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
        onKeyDown: (e: { key: string }) => {
          if (e.key === 'Escape') setQuery('')
        },
        style: {
          flex: 1,
          minWidth: 0,
          border: 'none',
          background: 'none',
          outline: 'none',
          fontFamily: SANS,
          fontSize: '0.75rem',
          color: 'var(--text-color)'
        }
      }),
      query
        ? h(
            'button',
            {
              onClick: () => setQuery(''),
              'aria-label': uiText('auto.67300d0fed7c'),
              title: uiText('auto.67300d0fed7c'),
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                color: 'var(--text-tertiary)'
              }
            },
            clearIcon(13)
          )
        : null
    )

    const listBody = noMatches
      ? h(
          'div',
          {
            key: 'list-body',
            style: {
              fontFamily: SANS,
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              padding: '10px 8px',
              textAlign: 'center'
            }
          },
          uiText('auto.4d6963a6dfbc', { p0: query.trim() })
        )
      : h(
          'div',
          { key: 'list-body', style: { display: 'flex', flexDirection: 'column' } },
          visibleGroups.map((g) => groupBlock(g, searching))
        )

    const body = h(
      'div',
      {
        className: 'workspace-panel panel-body',
        ref: panelRef,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          padding: '12px 5px',
          boxSizing: 'border-box',
          overflowY: 'auto'
        }
      },
      // Header: save current layout
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'div',
          {
            style: {
              fontFamily: SANS,
              fontSize: '0.6875rem',
              fontWeight: 700,
              letterSpacing: '0.03em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)'
            }
          },
          uiText('auto.aa4b0670d981')
        ),
        input(name, setName, uiText('auto.86d9d2611878'), doSave),
        groupField(group, chooseGroup)
      ),
      h('div', { style: { height: '1px', background: 'var(--border-light)', margin: '2px 0' } }),
      groups.length === 0
        ? h(
            'div',
            {
              style: {
                fontFamily: SANS,
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                padding: '12px 4px',
                textAlign: 'center',
                lineHeight: 1.5
              }
            },
            uiText('auto.6836ef27bc13')
          )
        : [searchBar, listBody]
    )

    return h(
      'div',
      { className: 'panel' },
      h(
        'div',
        { className: 'panel-header' },
        h('span', { className: 'panel-title' }, uiText('auto.4ca0a75c2b7f')),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '2px',
              WebkitAppRegion: 'no-drag'
            }
          },
          h(
            'button',
            {
              className: 'panel-tool-btn',
              title: active == null ? uiText('auto.8cbb1a7f46ac') : uiText('auto.0a69f67d3d95'),
              'aria-label': active == null ? uiText('auto.8cbb1a7f46ac') : uiText('auto.0a69f67d3d95'),
              disabled: active == null,
              onClick: () => void s?.setActive(null),
              style: { opacity: active == null ? 0.45 : 1 }
            },
            deselectIcon(15)
          ),
          h(
            'button',
            {
              className: 'panel-tool-btn',
              title: uiText('auto.aa4b0670d981'),
              onClick: doSave,
              disabled: name.trim().length === 0,
              style: {
                fontFamily: SANS,
                fontSize: '0.75rem',
                fontWeight: 600,
                width: 'auto',
                padding: '3px 10px',
                borderRadius: '6px',
                cursor: name.trim() ? 'pointer' : 'default',
                color: name.trim() ? '#fff' : 'var(--text-secondary)',
                background: name.trim() ? 'var(--accent-color)' : 'transparent',
                border: '1px solid ' + (name.trim() ? 'var(--accent-color)' : 'var(--border-light)'),
                opacity: name.trim() ? 1 : 0.7
              }
            },
            uiText('auto.efc007a393f6')
          )
        )
      ),
      body
    )
  }

  api.registerView('workspace.panel', Panel)
  api.registerView('workspace.footer', FooterItem)

  const offCommands = registerWorkspaceCommands(api)
  const offSurfaces = registerWorkspaceSurfaces(api)

  return () => {
    offCommands()
    offSurfaces()
    store.dispose()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
