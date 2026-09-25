import { React, api } from './runtime'
import { LAYOUT_SCOPES, getStore, layoutCounts, scopesOf, type LayoutScope, type LayoutScopes, type SavedLayout } from './store'
import { uiText } from './localization'
import {
  copyIcon,
  deselectIcon,
  folderPlusIcon,
  footerIcon,
  iconRailIcon,
  layersIcon,
  pencilIcon,
  rightSidebarIcon,
  saveIcon,
  trashIcon
} from './icons'

/**
 * The bits the sidebar panel and the manage modal both need: type/field styling,
 * the relative-time label, the `ACTIVE` pill, the shared row and group `⋯` menus
 * and both delete confirmations. One copy, so the two surfaces cannot drift.
 */

/**
 * The app's interface font. Was a hardcoded `'Helvetica Neue', Helvetica,
 * Arial` stack — mac-first, and a tokens-only violation besides: it ignored the
 * user's font preference and resolved to Arial on Windows and to whatever
 * fontconfig substitutes on Linux, so this modal never matched the rest of the
 * app anywhere but macOS.
 */
export const SANS = 'var(--interface-font)'

/** Compact "x ago" relative time (moment-style buckets), no dependencies. */
export function ago(ts: number): string {
  const relative = new Intl.RelativeTimeFormat(api.ui.language(), { numeric: 'auto' })
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return relative.format(0, 'second')
  if (s < 90) return relative.format(-1, 'minute')
  const m = Math.round(s / 60)
  if (m < 45) return relative.format(-m, 'minute')
  const h = Math.round(m / 60)
  if (h < 24) return relative.format(-h, 'hour')
  const d = Math.round(h / 24)
  if (d < 30) return relative.format(-d, 'day')
  const mo = Math.round(d / 30)
  if (mo < 12) return relative.format(-mo, 'month')
  const y = Math.round(mo / 12)
  return relative.format(-y, 'year')
}

export const fieldStyle = {
  flex: 1,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '7px 10px',
  fontFamily: SANS,
  // The shared ComboField beside these fields uses the same token.
  fontSize: 'var(--small-font-size)',
  color: 'var(--text-color)',
  background: 'var(--surface-color)',
  border: '1px solid var(--border-light)',
  borderRadius: '6px',
  outline: 'none'
}

export const pill = (text: string): ReturnType<typeof React.createElement> =>
  React.createElement(
    'span',
    {
      style: {
        fontFamily: SANS,
        fontSize: '0.5625rem',
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '2px 5px',
        borderRadius: '4px',
        color: 'var(--accent-tint-text)',
        background: 'var(--accent-tint-bg)',
        flexShrink: 0
      }
    },
    text
  )

// ── Saved parts (right sidebar, Icon Rail, footer) ─────────────────────────

const SCOPE_LABEL_KEYS: Record<LayoutScope, string> = {
  rightSidebar: 'auto.2eaf3cd2af32',
  iconRail: 'auto.586028e2b8fb',
  footer: 'auto.26c01e70a337'
}
const SCOPE_ICONS: Record<LayoutScope, (size?: number, color?: string) => ReturnType<typeof React.createElement>> = {
  rightSidebar: rightSidebarIcon,
  iconRail: iconRailIcon,
  footer: footerIcon
}

export const scopeLabel = (scope: LayoutScope): string => uiText(SCOPE_LABEL_KEYS[scope])

/**
 * "Also save: [Right sidebar] [Icon Rail] [Footer]" — the save form's choice of
 * optional parts, shared by the panel and the manager so both read the same.
 */
export const scopeToggles = (
  scopes: LayoutScopes,
  onChange: (next: LayoutScopes) => void,
  options?: { compact?: boolean }
): ReturnType<typeof React.createElement> =>
  React.createElement(
    'div',
    {
      role: 'group',
      'aria-label': uiText('auto.cc6db1d3ad44'),
      style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', minWidth: 0 }
    },
    React.createElement(
      'span',
      { style: { fontFamily: SANS, fontSize: 'var(--small-font-size)', color: 'var(--text-secondary)', marginRight: '2px' } },
      uiText('auto.cc6db1d3ad44')
    ),
    ...LAYOUT_SCOPES.map((scope) => {
      const on = scopes[scope]
      return React.createElement(
        'button',
        {
          key: scope,
          type: 'button',
          'aria-pressed': on,
          'data-scope': scope,
          onClick: () => onChange({ ...scopes, [scope]: !on }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            height: options?.compact ? '24px' : '26px',
            padding: options?.compact ? '0 7px' : '0 9px',
            borderRadius: '999px',
            border: `1px solid ${on ? 'var(--accent-color)' : 'var(--border-light)'}`,
            background: on ? 'var(--accent-tint-bg)' : 'transparent',
            color: on ? 'var(--accent-tint-text)' : 'var(--text-secondary)',
            fontFamily: SANS,
            fontSize: 'var(--small-font-size)',
            lineHeight: 1,
            cursor: 'pointer',
            whiteSpace: 'nowrap'
          }
        },
        SCOPE_ICONS[scope](13),
        scopeLabel(scope)
      )
    })
  )

/** The small icons naming which optional parts a saved layout carries. */
export const scopeBadges = (layout: SavedLayout): ReturnType<typeof React.createElement> | null => {
  const scopes = scopesOf(layout.snapshot)
  const included = LAYOUT_SCOPES.filter((scope) => scopes[scope])
  if (included.length === 0) return null
  return React.createElement(
    'span',
    {
      'data-testid': `workspace-scopes-${layout.name}`,
      'aria-label': included.map(scopeLabel).join(', '),
      style: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--text-tertiary)' }
    },
    ...included.map((scope) =>
      React.createElement(
        'span',
        { key: scope, 'data-scope': scope, ...api.ui.tooltip(scopeLabel(scope), { placement: 'top' }), style: { display: 'inline-flex' } },
        SCOPE_ICONS[scope](12)
      )
    )
  )
}

/** "2 panes · 5 tabs" for a saved layout's main workspace. */
export function countsLabel(layout: SavedLayout): string {
  const { panes, tabs } = layoutCounts(layout.snapshot)
  const paneText = panes === 1 ? uiText('auto.cab9512000d8') : uiText('auto.047bf7fc63c9', { p0: panes })
  const tabText = tabs === 1 ? uiText('auto.16df139253b6') : uiText('auto.a238dd6a3c0f', { p0: tabs })
  return `${paneText} · ${tabText}`
}

/** A localized line for a failed layout action; store errors are canonical English. */
export function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /already exists/.test(message) ? uiText('auto.7ed907c17e3a') : uiText('auto.b90e1f5b7fc7')
}

/**
 * Existing group names — the dropdown's options. Comes from the store, so a
 * group the user created without saving a layout into it is offered too.
 */
export function groupNames(): string[] {
  return getStore()?.groupNames() ?? []
}

/** Options for `api.ui.ComboField`, built from the saved layouts' groups. */
export function groupOptions(): { value: string; label: string }[] {
  return groupNames().map((g) => ({ value: g, label: g }))
}

export async function confirmDelete(layout: SavedLayout): Promise<boolean> {
  const choice = await api.ui.confirm({
    title: uiText('auto.6716d6269dc1'),
    message: React.createElement(
      'span',
      null,
      React.createElement('strong', null, layout.name),
      ` ${uiText('auto.bf3cb5254932')}`
    ),
    actions: [
      { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
      { label: uiText('auto.f6fdbe48dc54'), value: 'delete', variant: 'danger' }
    ]
  })
  if (choice !== 'delete') return false
  const s = getStore()
  if (!s?.find(layout.name)) return false
  await s.deleteByName(layout.name)
  return true
}

/**
 * The row menu, identical in the panel and the modal and reachable two ways —
 * the `⋯` button (anchored) or a right-click on the row (at the pointer):
 * Rename · Move to Group · Replace with current workspace · Duplicate ·
 * Includes (the layout's optional parts) · Deselect (ACTIVE layout only) ·
 * Delete. Presented by the host, so it follows Appearance → Action menus.
 *
 * Moving only ever targets an existing group — inventing one is the save form's
 * job (`groupField`), so this menu never needs a text input inside it.
 */
export function openLayoutMenu(
  layout: SavedLayout,
  target: HTMLElement | { x: number; y: number },
  handlers: { onRename: () => void; onError?: (error: unknown) => void }
): void {
  const s = getStore()
  if (!s) return
  const fail = (error: unknown): void => handlers.onError?.(error)
  const isActive = s.active != null && s.active.toLowerCase() === layout.name.toLowerCase()
  const current = layout.group.trim().toLowerCase()
  const names = s.groupNames()
  const move = names.map((name) => ({
    label: name,
    type: 'radio' as const,
    checked: name.toLowerCase() === current,
    onSelect: () => s.setGroup(layout.name, name).catch(fail)
  }))
  // "No group" only reads as an action once the layout is in one.
  if (current !== '') {
    move.push({
      label: uiText('auto.f6b2246c64fa'),
      type: 'radio' as const,
      checked: false,
      onSelect: () => s.setGroup(layout.name, '').catch(fail)
    })
  }
  const scopes = scopesOf(layout.snapshot)
  void api.ui.openMenu(
    [
      { label: uiText('auto.d3f4cb898fbe'), icon: pencilIcon(), onSelect: handlers.onRename },
      {
        label: uiText('auto.ab8e08b5a45e'),
        icon: folderPlusIcon(),
        enabled: move.length > 0,
        description: move.length === 0 ? uiText('auto.3a638d444486') : undefined,
        submenu: move
      },
      {
        label: uiText('auto.9ca8836283df'),
        icon: saveIcon(14, 'var(--text-secondary)'),
        onSelect: () => s.replaceWithCurrent(layout.name).catch(fail)
      },
      {
        label: uiText('auto.972d57379db3'),
        icon: copyIcon(),
        onSelect: () => s.duplicate(layout.name, (base, n) => n === 1 ? uiText('auto.8e09cfdc55ba', { p0: base }) : uiText('auto.636380fac693', { p0: base, p1: n })).catch(fail)
      },
      {
        label: uiText('auto.db54974f7f0a'),
        icon: layersIcon(),
        submenu: LAYOUT_SCOPES.map((scope) => ({
          label: scopeLabel(scope),
          type: 'checkbox' as const,
          checked: scopes[scope],
          icon: SCOPE_ICONS[scope](14, 'var(--text-secondary)'),
          onSelect: () => s.setScope(layout.name, scope, !scopes[scope]).catch(fail)
        }))
      },
      // Deselect belongs to the ACTIVE layout alone — the same action as the
      // panel header's deselect button.
      ...(isActive
        ? [{ label: uiText('auto.04d948a39210'), icon: deselectIcon(14), onSelect: () => s.setActive(null) }]
        : []),
      { type: 'separator' as const },
      {
        label: uiText('auto.f6fdbe48dc54'),
        icon: trashIcon(),
        danger: true,
        onSelect: () => confirmDelete(layout).catch(fail)
      }
    ],
    'ownerDocument' in target ? { anchor: target, align: 'end' } : target
  )
}

export async function confirmDeleteGroup(group: string): Promise<boolean> {
  const choice = await api.ui.confirm({
    title: uiText('auto.1d6345ce6b31'),
    message: React.createElement(
      'span',
      null,
      React.createElement('strong', null, group),
      ` ${uiText('auto.0e6f2c207242')}`
    ),
    actions: [
      { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
      { label: uiText('auto.f6fdbe48dc54'), value: 'delete', variant: 'danger' }
    ]
  })
  if (choice !== 'delete') return false
  const s = getStore()
  if (!s?.hasGroup(group)) return false
  await s.deleteGroup(group)
  return true
}

/**
 * The group-header menu: Rename group · Delete group. A header carries no `⋯` —
 * right-click opens this, double-clicking the name renames in place — and the
 * ungrouped bucket opens nothing at all, since neither action applies to it.
 * Deleting a group keeps its layouts; they fall back to ungrouped.
 */
export function openGroupMenu(
  group: string,
  target: HTMLElement | { x: number; y: number },
  handlers: { onRename: () => void }
): void {
  if (group.trim() === '') return
  void api.ui.openMenu(
    [
      { label: uiText('auto.673e72771575'), icon: pencilIcon(), onSelect: handlers.onRename },
      { type: 'separator' as const },
      {
        label: uiText('auto.b6f15b2f40a0'),
        icon: trashIcon(),
        danger: true,
        onSelect: () => confirmDeleteGroup(group)
      }
    ],
    'ownerDocument' in target ? { anchor: target, align: 'end' } : target
  )
}

/** The group dropdown of the save form — pick an existing group or name a new one. */
export const groupField = (
  value: string,
  onChange: (next: string) => void,
  extra?: { placeholder?: string; className?: string; ariaLabel?: string }
): ReturnType<typeof React.createElement> =>
  React.createElement(api.ui.ComboField, {
    value,
    onChange,
    options: groupOptions(),
    ariaLabel: extra?.ariaLabel ?? uiText('auto.4a65a16ee02b'),
    placeholder: extra?.placeholder ?? uiText('auto.c9b8f3283979'),
    clearLabel: uiText('auto.f6b2246c64fa'),
    customLabel: uiText('auto.6bcd99dee429'),
    className: extra?.className
  })
