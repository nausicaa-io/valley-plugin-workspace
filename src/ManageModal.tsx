import type { KeyboardEvent } from 'react'
import { React, api } from './runtime'
import { getStore, scopesOf, type LayoutScopes, type SavedLayout } from './store'
import { uiText } from './localization'
import { patchWorkspaceSurface, useWorkspaceSurface } from './surfaces'
import { chevronDownIcon, chevronRightIcon, clearIcon, folderIcon, moreIcon, searchIcon } from './icons'
import {
  SANS,
  ago,
  confirmDelete,
  countsLabel,
  failureText,
  fieldStyle,
  groupField,
  openGroupMenu,
  openLayoutMenu,
  pill,
  scopeBadges,
  scopeToggles
} from './ui'

/**
 * "Manage workspace layouts" — the full manager behind the footer chip.
 *
 * Grouped like the sidebar panel (collapsible headers + counts), searchable, and
 * keyboard-first: ↑/↓ walk the visible rows, Enter loads the highlighted one,
 * Backspace/Delete deletes it. A row *is* the load action (there is no separate
 * `Load` button); `⋯` holds rename / move to group / replace / duplicate /
 * included parts / delete and `✕` deletes.
 *
 * The modal grows with its content. Once the host caps it (90% of the window),
 * this frame scrolls and the save/search header stays pinned with `sticky`;
 * viewport units would measure this self-sizing frame, not the window.
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
  const [chosenScopes, setChosenScopes] = React.useState<LayoutScopes | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const headerRef = React.useRef<HTMLDivElement>(null)
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

  // Rows scrolled into view by the keyboard stop below the pinned header.
  React.useLayoutEffect(() => {
    const height = headerRef.current?.offsetHeight ?? 0
    rootRef.current?.style.setProperty('--workspace-header-height', `${height}px`)
  })

  const s = getStore()
  if (!s) return null
  const active = s.active
  const fail = (e: unknown): void => setError(failureText(e))
  const existing = saveName.trim() ? s.find(saveName.trim()) : undefined
  // Until the user picks parts, the toggles show what saving would keep: the
  // named layout's own parts when replacing it, else the settings' defaults.
  const saveScopes = chosenScopes ?? (existing ? scopesOf(existing.snapshot) : s.defaultScopes())

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
  // Keyed apart from any label, so a real group named "Ungrouped" collapses on its own.
  const collapseKey = (group: string): string => (group ? `g:${group.toLowerCase()}` : 'ungrouped')
  const isCollapsed = (group: string): boolean => !searching && collapsed[collapseKey(group)] === true
  // The flat, visible order the arrow keys walk (collapsed groups are skipped).
  const visibleRows = groups.flatMap((g) => (isCollapsed(g.group) ? [] : g.layouts))
  const clampedHighlight = visibleRows.length === 0 ? -1 : Math.min(highlight, visibleRows.length - 1)

  const load = (layout: SavedLayout): void => {
    patchWorkspaceSurface('footer', { selected: layout.name })
    void s.loadByName(layout.name).then(onClose, fail)
  }

  const doSave = (): void => {
    const trimmed = saveName.trim()
    if (!trimmed) return
    setError(null)
    void s.saveCurrent(trimmed, saveGroup.trim(), saveScopes).then(() => {
      setSaveName('')
      setSaveGroup('')
      setChosenScopes(null)
    }, fail)
  }

  const commitRename = (oldName: string): void => {
    const next = renameDraft.trim()
    setRenaming(null)
    if (!next || next === oldName) return
    void s.renameByName(oldName, next).catch(fail)
  }

  const startGroupRename = (groupKey: string): void => {
    setGroupRenameDraft(groupKey)
    setGroupRenaming(groupKey)
  }

  const commitGroupRename = (oldGroup: string): void => {
    const next = groupRenameDraft.trim()
    setGroupRenaming(null)
    if (!next || next === oldGroup) return
    void s.renameGroup(oldGroup, next).catch(fail)
  }

  // Same group actions as the sidebar panel (see `index.tsx`): naming an unknown
  // group creates it, with no layout in it.
  const chooseGroup = (next: string): void => {
    setSaveGroup(next)
    const trimmed = next.trim()
    if (!trimmed || s.hasGroup(trimmed)) return
    void s.createGroup(trimmed).catch(fail)
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
      const row = rootRef.current?.querySelector(`[data-row-index="${index}"]`)
      row?.scrollIntoView?.({ block: 'nearest' })
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

  // ── Save row: name + group dropdown + Save, then the parts to include ────
  const canSave = saveName.trim().length > 0
  const saveRow = React.createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
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
      style: { ...fieldStyle, height: '32px' }
    }),
    React.createElement(
      'div',
      { style: { width: '200px', display: 'flex', flexShrink: 0 } },
      groupField(saveGroup, chooseGroup)
    ),
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: doSave,
        disabled: !canSave,
        style: {
          height: '32px',
          minWidth: '72px',
          padding: '0 14px',
          flexShrink: 0,
          border: `1px solid ${canSave ? 'var(--accent-color)' : 'var(--border-light)'}`,
          borderRadius: '6px',
          background: canSave ? 'var(--accent-color)' : 'transparent',
          color: canSave ? 'var(--accent-contrast)' : 'var(--text-secondary)',
          fontFamily: SANS,
          fontSize: 'var(--small-font-size)',
          fontWeight: 600,
          cursor: canSave ? 'pointer' : 'default',
          opacity: canSave ? 1 : 0.7
        }
      },
      existing ? uiText('auto.a7cf7b25a703') : uiText('auto.efc007a393f6')
    )
  )
  const scopeRow = React.createElement(
    'div',
    { style: { paddingTop: '10px' } },
    scopeToggles(saveScopes, setChosenScopes)
  )
  const errorRow = error
    ? React.createElement(
        'div',
        {
          role: 'alert',
          style: { paddingTop: '8px', fontFamily: SANS, fontSize: 'var(--small-font-size)', color: 'var(--danger-tint-text)' }
        },
        error
      )
    : null

  // ── Search row (also the keyboard-nav driver, so it takes initial focus) ────
  const searchRow = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        marginTop: '12px',
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
        fontSize: 'var(--small-font-size)',
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
      },
      onError: fail
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
          style: { ...fieldStyle, padding: '4px 8px', fontSize: '0.8125rem', fontWeight: 600 }
        })
      : React.createElement(
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

    const meta = React.createElement(
      'span',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0,
          fontFamily: SANS,
          fontSize: '0.6875rem',
          color: 'var(--text-secondary)'
        }
      },
      React.createElement(
        'span',
        { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        `${uiText('auto.7a9c4f78c9b7', { p0: ago(layout.modifiedAt) })} · ${countsLabel(layout)}`
      ),
      scopeBadges(layout)
    )

    const body = React.createElement(
      'div',
      { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px', textAlign: 'left' } },
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
        nameEl,
        isActive ? pill(uiText('auto.a733b809d2f1')) : null
        // No group chip: every row already sits under its group header.
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
            'aria-current': isActive ? 'true' : undefined,
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
        'data-row-index': index,
        'data-highlighted': highlighted ? 'true' : undefined,
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
          paddingRight: '4px',
          borderRadius: '7px',
          scrollMarginTop: 'calc(var(--workspace-header-height, 0px) + 4px)',
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
        moreIcon(16)
      ),
      iconButton(
        'delete',
        {
          title: uiText('auto.7dc25b134780', { p0: layout.name }),
          ariaLabel: uiText('auto.a589e1949a7a', { p0: layout.name }),
          onClick: () => void confirmDelete(layout)
        },
        clearIcon(14, 'currentColor')
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
            onClick: () => setCollapsed((prev) => ({ ...prev, [collapseKey(g.group)]: !prev[collapseKey(g.group)] })),
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

  const hasContent = s.layouts.length > 0 || s.groups().length > 0
  // Pinned while the frame scrolls; the modal surface behind it hides the rows
  // passing underneath.
  const header = React.createElement(
    'div',
    {
      ref: headerRef,
      style: { position: 'sticky', top: 0, zIndex: 2, background: 'var(--modal-bg)', paddingBottom: '6px' }
    },
    saveRow,
    scopeRow,
    errorRow,
    React.createElement('div', { style: { height: '1px', background: 'var(--border-light)', marginTop: '12px' } }),
    hasContent ? searchRow : null
  )

  return React.createElement(
    'div',
    {
      ref: rootRef,
      'data-testid': 'workspace-switcher',
      onKeyDown,
      style: { display: 'flex', flexDirection: 'column', minHeight: '320px', fontFamily: SANS }
    },
    header,
    !hasContent
      ? emptyState(uiText('auto.4948447e8d49'))
      : groups.length === 0
        ? emptyState(uiText('auto.4d6963a6dfbc', { p0: query.trim() }))
        : React.createElement('div', { style: { display: 'flex', flexDirection: 'column' } }, ...groupBlocks)
  )
}
