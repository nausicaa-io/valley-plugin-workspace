import { React } from './runtime'

/**
 * The plugin's glyph set, shared by the sidebar panel and the manage modal.
 *
 * All hand-inlined: a plugin bundle cannot import react-icons — that drags in a
 * second React instance and trips the tripwire in `tooling/build/build-plugins.mjs`.
 * The originals are named per icon so a future swap can be looked up.
 */
type Element = ReturnType<typeof React.createElement>

/** Lazy so the module can be imported before `initRuntime()` has set `React`. */
const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]): Element =>
  (React.createElement as (t: string, p: unknown, ...c: unknown[]) => Element)(tag, props, ...children)

/** Lucide-style stroke icon, mirroring the music plugin's icons.tsx palette. */
export const lineIcon = (paths: string[], size = 13, color = 'var(--text-tertiary)'): Element =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { color, flexShrink: 0, display: 'block' }
    },
    ...paths.map((d, i) => h('path', { key: i, d }))
  )

/** react-icons `VscLayoutPanelDock` — the footer's one-tap save button. */
export const saveIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'currentColor',
      style: { color, flexShrink: 0, display: 'block' }
    },
    h('path', { d: 'M15 2V14L14 15H2L1 14V2L2 1H14L15 2ZM2 10H14V2H2V10Z' }),
    h('path', {
      d: 'M8.5 3V7.29297L9.64648 6.14648L10.3535 6.85352L8.35352 8.85352H7.64648L5.64648 6.85352L6.35352 6.14648L7.5 7.29297V3H8.5Z'
    })
  )

/** react-icons/io5 `IoCheckmarkDone` — the footer's "saved, nothing to save" state. */
export const checkmarkDoneIcon = (size = 14, color = 'var(--accent-color)'): Element =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 512 512',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 32,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { color, flexShrink: 0, display: 'block' }
    },
    h('path', { d: 'M464 128 240 384l-96-96m0 96-96-96m320-160L232 284' })
  )

/** react-icons/md `MdDeselect` — the panel header's "drop the ACTIVE layout" button. */
export const deselectIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      style: { color, flexShrink: 0, display: 'block' }
    },
    h('path', {
      d: 'M3 13h2v-2H3zm4 8h2v-2H7zm6-18h-2v2h2zm6 0v2h2c0-1.1-.9-2-2-2M5 21v-2H3c0 1.1.9 2 2 2m-2-4h2v-2H3zm8 4h2v-2h-2zm8-8h2v-2h-2zm0-4h2V7h-2zm-4-4h2V3h-2zM7.83 5 7 4.17V3h2v2zm12 12-.83-.83V15h2v2zm1.36 4.19L2.81 2.81 1.39 4.22 4.17 7H3v2h2V7.83l2 2V17h7.17l2 2H15v2h2v-1.17l2.78 2.78zM9 15v-3.17L12.17 15zm6-2.83V9h-3.17l-2-2H17v7.17z'
    })
  )

export const chevronDownIcon = (size = 10, color = 'var(--text-tertiary)'): Element =>
  lineIcon(['m6 9 6 6 6-6'], size, color)
export const chevronRightIcon = (size = 10, color = 'var(--text-tertiary)'): Element =>
  lineIcon(['m9 18 6-6-6-6'], size, color)
export const folderIcon = (size = 13, color = 'var(--text-tertiary)'): Element =>
  lineIcon(
    ['M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9L12 8H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
    size,
    color
  )
export const clearIcon = (size = 13, color = 'var(--text-tertiary)'): Element =>
  lineIcon(['M18 6 6 18M6 6l12 12'], size, color)
export const searchIcon = (size = 13, color = 'var(--text-tertiary)'): Element =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { color, flexShrink: 0, display: 'block' }
    },
    h('circle', { cx: 11, cy: 11, r: 8 }),
    h('path', { d: 'm21 21-4.3-4.3' })
  )

// ── Layout `⋯` menu icons (Rename / Change group / Save / Delete) ─────────────
export const pencilIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  lineIcon(['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'm15 5 4 4'], size, color)
export const folderPlusIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  lineIcon(
    [
      'M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9L12 8H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
      'M12 11v6',
      'M9 14h6'
    ],
    size,
    color
  )
export const trashIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  lineIcon(
    ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6'],
    size,
    color
  )

/** Remix fill icon (24×24), the family the app's Appearance layout pages use. */
const fillIcon = (d: string, size: number, color: string): Element =>
  h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      style: { color, flexShrink: 0, display: 'block' }
    },
    h('path', { d })
  )

// ── Saved layout parts: the same glyphs as Appearance → Icon Rail / Footer Rail ──
/** react-icons/ri `RiLayoutRightLine` — the right sidebar. */
export const rightSidebarIcon = (size = 14, color = 'currentColor'): Element =>
  fillIcon(
    'M21 3C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM15 5H4V19H15V5ZM20 5H17V19H20V5Z',
    size,
    color
  )
/** react-icons/ri `RiLayoutLeftLine` — the Icon Rail. */
export const iconRailIcon = (size = 14, color = 'currentColor'): Element =>
  fillIcon(
    'M21 3C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM7 5H4V19H7V5ZM20 5H9V19H20V5Z',
    size,
    color
  )
/** react-icons/ri `RiLayoutBottomLine` — the footer. */
export const footerIcon = (size = 14, color = 'currentColor'): Element =>
  fillIcon(
    'M21 3C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM4 16V19H20V16H4ZM4 14H20V5H4V14Z',
    size,
    color
  )
/** react-icons/ri `RiMoreFill` — a row's overflow menu. */
export const moreIcon = (size = 16, color = 'currentColor'): Element =>
  fillIcon(
    'M5 10C3.9 10 3 10.9 3 12C3 13.1 3.9 14 5 14C6.1 14 7 13.1 7 12C7 10.9 6.1 10 5 10ZM19 10C17.9 10 17 10.9 17 12C17 13.1 17.9 14 19 14C20.1 14 21 13.1 21 12C21 10.9 20.1 10 19 10ZM12 10C10.9 10 10 10.9 10 12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12C14 10.9 13.1 10 12 10Z',
    size,
    color
  )
/** Lucide `copy` — Duplicate. */
export const copyIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  lineIcon(
    ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
    size,
    color
  )
/** Lucide `layers` — the Includes submenu. */
export const layersIcon = (size = 14, color = 'var(--text-secondary)'): Element =>
  lineIcon(
    [
      'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
      'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65',
      'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'
    ],
    size,
    color
  )
