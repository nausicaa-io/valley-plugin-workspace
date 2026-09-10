import type { KeyboardEvent } from 'react'
import { React, api } from './runtime'
import { getStore, type SavedLayout } from './store'
import { uiText } from './localization'
import { patchWorkspaceSurface, useWorkspaceSurface } from './surfaces'
import { chevronDownIcon, chevronRightIcon, clearIcon, folderIcon, searchIcon } from './icons'
import {
  SANS,
  ago,
  confirmDelete,
  fieldStyle,
  groupChip,
  groupField,
  openGroupMenu,
  openLayoutMenu,
  pill
} from './ui'

/**
 * "Manage workspace layouts" — the full manager behind the footer chip.
 *
 * Grouped like the sidebar panel (collapsible headers + counts), searchable, and
 * keyboard-first: ↑/↓ walk the visible rows, Enter loads the highlighted one,
 * Backspace/Delete deletes it. A row *is* the load action (there is no separate
 * `Load` button); `⋯` holds rename / move to group / save / delete and `✕`
 * deletes.
 * Escape, Tab-trapping and backdrop dismissal come from the host `api.ui.Modal`
 * that renders this.
 */

const SAVE_INPUT_ATTR = 'data-workspace-save-input'

export const ManageModal = ({
  onClose,
  initialFocus = 'search'
}: {
  onClose: () => void
  initialFocus?: 'search' | 'save'
}): ReturnType<typeof React.createElement> | null => {
  const [, force] = React.useState(0)
  const [saveName, setSaveName] = React.useState('')
  const [saveGroup, setSaveGroup] = React.useState('')
  const { query } = useWorkspaceSurface('footer')
  const setQuery = (query: string): void => patchWorkspaceSurface('footer', { query })
  const [highlight, setHighlight] = React.useState(0)
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [renameDraft, setRenameDraft] = React.useState('')
  const [groupRenaming, setGroupRenaming] = React.useState<string | null>(null)
  const [groupRenameDraft, setGroupRenameDraft] = React.useState('')

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
  const active = s.active

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matchesQuery = (l: SavedLayout): boolean =>
    l.name.toLowerCase().includes(q) || l.group.toLowerCase().includes(q)
  const groupMatches = (group: string): boolean => group !== '' && group.toLowerCase().includes(q)
  const groups = searching
    ? s
        .groups()
        .map((g) => (groupMatches(g.group) ? g : { group: g.group, layouts: g.layouts.filter(matchesQuery) }))
        .filter((g) => g.layouts.length > 0 || groupMatches(g.group))
    : s.groups()
  const showGroupHeaders = groups.length > 1 || (groups[0]?.group ?? '') !== ''

  const label = (group: string): string => group || uiText('auto.a7746fee0fd8')
  const isCollapsed = (group: string): boolean => !searching && collapsed[label(group)] === true
  // The flat, visible order the arrow keys walk (collapsed groups are skipped).
  const visibleRows = groups.flatMap((g) => (isCollapsed(g.group) ? [] : g.layouts))
  const clampedHighlight = visibleRows.length === 0 ? -1 : Math.min(highlight, visibleRows.length - 1)

  const load = (layout: SavedLayout): void => {
    patchWorkspaceSurface('footer', { selected: layout.name })
    void s.loadByName(layout.name).then(onClose)
  }

  const doSave = (): void => {
    const trimmed = saveName.trim()
    if (!trimmed) return
    void s.saveCurrent(trimmed, saveGroup.trim()).then(() => {
      setSaveName('')
      setSaveGroup('')
    })
  }

  const commitRename = (oldName: string): void => {
    const next = renameDraft.trim()
    setRenaming(null)
    if (!next || next === oldName) return
    void s.renameByName(oldName, next).catch(() => undefined)
  }

  const startGroupRename = (groupKey: string): void => {
    setGroupRenameDraft(groupKey)
    setGroupRenaming(groupKey)
  }

  const commitGroupRename = (oldGroup: string): void => {
    const next = groupRenameDraft.trim()
    setGroupRenaming(null)
    if (!next || next === oldGroup) return
    void s.renameGroup(oldGroup, next).catch(() => undefined)
  }

  // Same group actions as the sidebar panel (see `index.tsx`): naming an unknown
  // group creates it, with no layout in it.
  const chooseGroup = (next: string): void => {
    setSaveGroup(next)
    const trimmed = next.trim()
    if (!trimmed || s.hasGroup(trimmed)) return
    void s.createGroup(trimmed).catch(() => undefined)
  }

  const openHeaderMenu = (groupKey: string, target: HTMLElement | { x: number; y: number }): void =>
    openGroupMenu(groupKey, target, { onRename: () => startGroupRename(groupKey) })

  // ── Keyboard: one handler on the content wrapper (events bubble from inputs) ──
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    // The save-as field owns its own keys (Enter = save); rename/group inputs
    // stop propagation themselves.
    if (target.getAttribute?.(SAVE_INPUT_ATTR) === 'true') return
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    const move = (next: number): void => {
      event.preventDefault()
      if (visibleRows.length === 0) return
      const index = (next + visibleRows.length) % visibleRows.length
      setHighlight(index)
      patchWorkspaceSurface('footer', { selected: visibleRows[index].name })
    }
    if (event.key === 'ArrowDown') return move(clampedHighlight + 1)
    if (event.key === 'ArrowUp') return move(clampedHighlight <= 0 ? visibleRows.length - 1 : clampedHighlight - 1)
    if (!typing && event.key === 'Home') return move(0)
    if (!typing && event.key === 'End') return move(visibleRows.length - 1)
    const row = clampedHighlight >= 0 ? visibleRows[clampedHighlight] : null
    if (!row) return
    if (event.key === 'Enter') {
      event.preventDefault()
      load(row)
      return
    }
    if (!typing && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      void confirmDelete(row)
    }
  }

  // ── Save row: name + group dropdown + Save ─────────────────────────────────
  const saveRow = React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingBottom: '12px' } },
    React.createElement('input', {
      value: saveName,
      placeholder: uiText('auto.21679e71f164'),
      spellCheck: false,
      [SAVE_INPUT_ATTR]: 'true',
      ...(initialFocus === 'save' ? { 'data-modal-initial-focus': 'true' } : {}),
      onChange: (event: { target: { value: string } }) => setSaveName(event.target.value),
      onKeyDown: (event: { key: string; preventDefault: () => void }) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        doSave()
      },
      style: { ...fieldStyle, height: '36px' }
    }),
    React.createElement(
      'div',
      { style: { width: '180px', height: '36px', display: 'flex', flexShrink: 0 } },
      groupField(saveGroup, chooseGroup)
    ),
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: doSave,
        disabled: saveName.trim().length === 0,
        style: {
          height: '36px',
          padding: '0 14px',
          flexShrink: 0,
          border: '1px solid var(--border-light)',
          borderRadius: '6px',
          background: 'var(--surface-color)',
          color: 'var(--text-color)',
          boxShadow: '0 2px 5px rgba(0, 0, 0, 0.12)',
          fontFamily: SANS,
          fontSize: '0.8125rem',
          cursor: saveName.trim() ? 'pointer' : 'default',
          opacity: saveName.trim() ? 1 : 0.55
        }
      },
      uiText('auto.efc007a393f6')
    )
  )

  // ── Search row (also the keyboard-nav driver, so it takes initial focus) ────
  const searchRow = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        margin: '12px 0 4px',
        padding: '7px 10px',
        border: '1px solid var(--border-light)',
        borderRadius: '6px',
        // Same surface as the save field above — `--container-color-alt` reads as
        // a hard black slab against the modal in the dark theme.
        background: 'var(--surface-color)'
      }
    },
    searchIcon(13),
    React.createElement('input', {
      value: query,
      placeholder: uiText('auto.03a5e4943986'),
      spellCheck: false,
      ...(initialFocus === 'search' ? { 'data-modal-initial-focus': 'true' } : {}),
      onChange: (event: { target: { value: string } }) => {
        setQuery(event.target.value)
        setHighlight(0)
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Escape') setQuery('')
      },
      style: {
        flex: 1,
        minWidth: 0,
        border: 'none',
        background: 'none',
        outline: 'none',
        fontFamily: SANS,
        fontSize: '0.8125rem',
        color: 'var(--text-color)'
      }
    }),
    query
      ? React.createElement(
          'button',
          {
            type: 'button',
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

  const iconButton = (
    key: string,
    props: { title: string; ariaLabel: string; onClick: (event: { currentTarget: HTMLElement }) => void },
    child: ReturnType<typeof React.createElement> | string
  ): ReturnType<typeof React.createElement> =>
    React.createElement(
      'button',
      {
        key,
        type: 'button',
        title: props.title,
        'aria-label': props.ariaLabel,
        onClick: props.onClick,
        style: {
          width: '28px',
          height: '28px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--text-secondary)',
          fontFamily: SANS,
          fontSize: '1rem',
          lineHeight: 1,
          padding: 0,
          cursor: 'pointer'
        }
      },
      child
    )

  /** One menu for both entry points: the `⋯` button and a row right-click. */
  const openRowMenu = (layout: SavedLayout, target: HTMLElement | { x: number; y: number }): void => {
    patchWorkspaceSurface('footer', { selected: layout.name })
    openLayoutMenu(layout, target, {
      onRename: () => {
        setRenameDraft(layout.name)
        setRenaming(layout.name)
      }
    })
  }

  const row = (layout: SavedLayout, index: number): ReturnType<typeof React.createElement> => {
    const isActive = active != null && layout.name.toLowerCase() === active.toLowerCase()
    const highlighted = index === clampedHighlight
    const isRenaming = renaming === layout.name

    const nameEl = isRenaming
      ? React.createElement('input', {
          value: renameDraft,
          autoFocus: true,
          spellCheck: false,
          onChange: (event: { target: { value: string } }) => setRenameDraft(event.target.value),
          onBlur: () => commitRename(layout.name),
          onKeyDown: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename(layout.name)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(null)
            }
          },
          style: { ...fieldStyle, padding: '4px 8px', fontSize: '0.875rem', fontWeight: 600 }
        })
      : React.createElement(
          'span',
          {
            style: {
              fontFamily: SANS,
              fontSize: '0.875rem',
              fontWeight: 500,
              color: 'var(--text-color)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }
          },
          layout.name
        )

    const meta = React.createElement(
      'span',
      { style: { fontFamily: SANS, fontSize: '0.6875rem', color: 'var(--text-secondary)' } },
      uiText('auto.7a9c4f78c9b7', { p0: ago(layout.modifiedAt) })
    )

    const body = React.createElement(
      'div',
      { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px', textAlign: 'left' } },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        nameEl,
        isActive ? pill(uiText('auto.a733b809d2f1')) : null,
        layout.group ? groupChip(layout.group) : null
      ),
      meta
    )

    // The row itself is the load action; keeping the aria-labelled button inside
    // the testid wrapper keeps `within(row).getByRole('button', …)` working.
    const loadTarget = isRenaming
      ? React.createElement('div', { style: { flex: 1, minWidth: 0, padding: '8px 10px' } }, body)
      : React.createElement(
          'button',
          {
            type: 'button',
            'aria-label': uiText('auto.fc4a5bfcb64a', { p0: layout.name }),
            'aria-selected': highlighted,
            onClick: () => load(layout),
            onMouseEnter: () => setHighlight(index),
            style: {
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              padding: '8px 10px',
              border: 'none',
              borderRadius: '7px',
              background: 'transparent',
              cursor: 'pointer'
            }
          },
          body
        )

    return React.createElement(
      'div',
      {
        key: layout.name,
        'data-testid': `workspace-switcher-row-${layout.name}`,
        // Right-click opens the same menu as `⋯`, at the pointer.
        onContextMenu: (e: {
          preventDefault: () => void
          stopPropagation: () => void
          clientX: number
          clientY: number
        }) => {
          if (isRenaming) return
          e.preventDefault()
          e.stopPropagation()
          setHighlight(index)
          openRowMenu(layout, { x: e.clientX, y: e.clientY })
        },
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          borderRadius: '7px',
          background: highlighted ? 'var(--hover-bg)' : 'transparent'
        }
      },
      loadTarget,
      iconButton(
        'menu',
        {
          title: uiText('auto.a1e34f91579d'),
          ariaLabel: uiText('auto.f3e477e6f573', { p0: layout.name }),
          onClick: (event) => {
            setHighlight(index)
            openRowMenu(layout, event.currentTarget)
          }
        },
        '⋯'
      ),
      iconButton(
        'delete',
        {
          title: uiText('auto.7dc25b134780', { p0: layout.name }),
          ariaLabel: uiText('auto.a589e1949a7a', { p0: layout.name }),
          onClick: () => void confirmDelete(layout)
        },
        clearIcon(16)
      )
    )
  }

  let rowIndex = -1
  const groupBlocks = groups.map((g) => {
    const groupLabel = label(g.group)
    const groupKey = g.group.trim()
    const collapsedNow = isCollapsed(g.group)
    const isRenamingGroup = groupKey !== '' && groupRenaming === groupKey
    const labelEl = isRenamingGroup
      ? React.createElement('input', {
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
      : React.createElement(
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
          groupLabel
        )
    const header = showGroupHeaders
      ? React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setCollapsed((prev) => ({ ...prev, [groupLabel]: !prev[groupLabel] })),
            onContextMenu: (event: {
              preventDefault: () => void
              stopPropagation: () => void
              clientX: number
              clientY: number
            }) => {
              if (isRenamingGroup) return
              event.preventDefault()
              event.stopPropagation()
              openHeaderMenu(groupKey, { x: event.clientX, y: event.clientY })
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              width: '100%',
              padding: '6px 8px',
              marginTop: '4px',
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
            }
          },
          collapsedNow ? chevronRightIcon() : chevronDownIcon(),
          folderIcon(),
          labelEl,
          React.createElement(
            'span',
            { style: { fontWeight: 500, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' } },
            `${g.layouts.length}`
          )
        )
      : null
    const rows = collapsedNow
      ? []
      : g.layouts.map((layout) => {
          rowIndex += 1
          return row(layout, rowIndex)
        })
    // An empty group is a real place — say so rather than showing a bare header.
    const emptyHint =
      !collapsedNow && g.layouts.length === 0
        ? React.createElement(
            'div',
            {
              key: 'empty',
              style: {
                fontFamily: SANS,
                fontSize: '0.6875rem',
                color: 'var(--text-tertiary)',
                padding: '2px 8px 8px 32px'
              }
            },
            uiText('auto.3e50062d85cc')
          )
        : null
    return React.createElement(
      'div',
      {
        key: `g-${groupLabel}`,
        'data-testid': `workspace-switcher-group-${g.group || 'ungrouped'}`
      },
      header,
      ...rows,
      emptyHint
    )
  })

  const emptyState = (message: string): ReturnType<typeof React.createElement> =>
    React.createElement(
      'div',
      {
        style: {
          fontFamily: SANS,
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          padding: '24px 8px 10px',
          textAlign: 'center',
          lineHeight: 1.5
        }
      },
      message
    )

  return React.createElement(
    'div',
    {
      'data-testid': 'workspace-switcher',
      onKeyDown,
      style: { display: 'flex', flexDirection: 'column', minHeight: '120px', fontFamily: SANS }
    },
    saveRow,
    React.createElement('div', { style: { height: '1px', background: 'var(--border-light)' } }),
    s.layouts.length === 0 && s.groups().length === 0
      ? emptyState(uiText('auto.4948447e8d49'))
      : React.createElement(
          React.Fragment,
          null,
          searchRow,
          groups.length === 0
            ? emptyState(uiText('auto.4d6963a6dfbc', { p0: query.trim() }))
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', maxHeight: '52vh', overflowY: 'auto' } },
                ...groupBlocks
              )
        )
  )
}
