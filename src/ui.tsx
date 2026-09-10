import { React, api } from './runtime'
import { getStore, type SavedLayout } from './store'
import { uiText } from './localization'
import { deselectIcon, folderPlusIcon, pencilIcon, saveIcon, trashIcon } from './icons'

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
  fontSize: '0.8125rem',
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

/** The muted group label shown on a row, so "where is this saved" is always visible. */
export const groupChip = (group: string): ReturnType<typeof React.createElement> =>
  React.createElement(
    'span',
    {
      style: {
        fontFamily: SANS,
        fontSize: '0.625rem',
        padding: '2px 6px',
        borderRadius: '999px',
        color: 'var(--text-secondary)',
        background: 'var(--container-color-alt)',
        border: '1px solid var(--border-light)',
        flexShrink: 0,
        maxWidth: '120px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    },
    group
  )

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
 * Rename · Move to Group (a submenu of the groups that exist) · Save changes
 * here + Deselect (ACTIVE layout only) · Delete. Presented by the host, so it
 * follows Appearance → Action menus.
 *
 * Moving only ever targets an existing group — inventing one is the save form's
 * job (`groupField`), so this menu never needs a text input inside it.
 */
export function openLayoutMenu(
  layout: SavedLayout,
  target: HTMLElement | { x: number; y: number },
  handlers: { onRename: () => void }
): void {
  const s = getStore()
  if (!s) return
  const isActive = s.active != null && s.active.toLowerCase() === layout.name.toLowerCase()
  const current = layout.group.trim().toLowerCase()
  const names = s.groupNames()
  const move = names.map((name) => ({
    label: name,
    type: 'radio' as const,
    checked: name.toLowerCase() === current,
    onSelect: () => s.setGroup(layout.name, name)
  }))
  // "No group" only reads as an action once the layout is in one.
  if (current !== '') {
    move.push({
      label: uiText('auto.f6b2246c64fa'),
      type: 'radio' as const,
      checked: false,
      onSelect: () => s.setGroup(layout.name, '')
    })
  }
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
      // Save-changes-here and Deselect belong to the ACTIVE layout alone — the
      // same pair as the panel header's deselect button. A non-active layout
      // gets neither: there is nothing to save into it, and clicking the row
      // already loads it, so a "Select" entry would only say it twice.
      ...(isActive
        ? [
            {
              label: uiText('auto.8c19d5a063c0'),
              icon: saveIcon(14, 'var(--text-secondary)'),
              onSelect: () => s.saveCurrent(layout.name, layout.group)
            },
            { label: uiText('auto.04d948a39210'), icon: deselectIcon(14), onSelect: () => s.setActive(null) }
          ]
        : []),
      { type: 'separator' as const },
      {
        label: uiText('auto.f6fdbe48dc54'),
        icon: trashIcon(),
        danger: true,
        onSelect: () => confirmDelete(layout)
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
