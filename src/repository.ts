import type { DatasetRecord, DatasetTransactionOperation, ValleyPluginApi } from '@valley/plugin-sdk'
import type { WorkspaceLayoutSnapshot } from '@valley/plugin-sdk/types'
import { storedSnapshot } from './layoutState'

export interface SavedLayout {
  name: string
  /** Optional group label; empty string means ungrouped. */
  group: string
  snapshot: WorkspaceLayoutSnapshot
  createdAt: number
  modifiedAt: number
}

export const GROUPS_DATASET = 'workspace_groups'
export const LAYOUTS_DATASET = 'workspace_layouts'

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

function changes(dataset: string, previous: DatasetRecord[], next: DatasetRecord[]): DatasetTransactionOperation[] {
  const before = new Map(previous.map(row => [String(row.name), row]))
  const after = new Map<string, DatasetRecord>()
  for (const row of next) {
    const name = String(row.name)
    if (after.has(name)) throw new Error(`Duplicate Workspace record name: ${name}`)
    after.set(name, row)
  }
  const operations: DatasetTransactionOperation[] = []
  const keys = [...before.keys()].filter(name => !after.has(name)).map(name => ({ name }))
  if (keys.length === 1) operations.push({ dataset, operation: 'delete', key: keys[0] })
  else if (keys.length) operations.push({ dataset, operation: 'delete-many', keys })
  const inserted: DatasetRecord[] = []
  const updates: Array<{ key: { name: string }; values: DatasetRecord }> = []
  for (const [name, row] of after) {
    const old = before.get(name)
    if (!old) inserted.push(row)
    else {
      const values = Object.fromEntries(Object.entries(row).filter(([key, value]) => key !== 'name' && !sameValue(old[key], value)))
      if (Object.keys(values).length) updates.push({ key: { name }, values })
    }
  }
  if (inserted.length) operations.push({ dataset, operation: 'insert', values: inserted.length === 1 ? inserted[0] : inserted })
  if (updates.length === 1) operations.push({ dataset, operation: 'update', ...updates[0] })
  else if (updates.length) operations.push({ dataset, operation: 'update-many', updates })
  return operations
}

export class WorkspaceRepository {
  pending: Promise<void> = Promise.resolve()
  failure: { reason: unknown } | null = null

  constructor(private readonly api: ValleyPluginApi, private readonly notify: () => void) {}

  async drain(): Promise<void> {
    let pending: Promise<void>
    do { pending = this.pending; await pending } while (pending !== this.pending)
    if (this.failure) throw this.failure.reason
  }

  save(layouts: SavedLayout[], groups: string[]): Promise<void> {
    let captured: { layouts: SavedLayout[] } | { error: unknown }
    try { captured = { layouts: JSON.parse(JSON.stringify(layouts)) } }
    catch (error) { captured = { error } }
    const capturedGroups = [...groups]
    const run = async (): Promise<void> => {
      if ('error' in captured) throw captured.error
      const reads = await Promise.allSettled([this.readDataset(LAYOUTS_DATASET), this.readDataset(GROUPS_DATASET)])
      const failed = reads.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      const [oldLayouts, oldGroups] = reads.map(result => result.status === 'fulfilled' ? result.value : [])
      const operations = [
        ...changes(LAYOUTS_DATASET, oldLayouts, captured.layouts.map(layout => ({
          name: layout.name,
          group: layout.group,
          snapshotVersion: 1,
          snapshot: layout.snapshot as unknown as DatasetRecord,
          createdAt: layout.createdAt,
          modifiedAt: layout.modifiedAt
        }))),
        ...changes(GROUPS_DATASET, oldGroups, capturedGroups.map((name, position) => ({ name, position })))
      ]
      if (operations.length) await this.api.data.transaction(operations)
      this.notify()
    }
    return this.enqueue(run)
  }

  reject(error: unknown): Promise<void> { return this.enqueue(async () => { throw error }) }

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.pending.then(run, run)
    this.pending = next.then(
      () => { this.failure = null },
      (reason) => { this.failure = { reason } }
    )
    return next
  }

  async readDataset(dataset: string, cancelled: () => boolean = () => false): Promise<DatasetRecord[]> {
    const rows: DatasetRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.api.data.dataset(dataset).query({ limit: 1000, cursor })
      rows.push(...page.rows)
      cursor = page.cursor
    } while (cursor && !cancelled())
    return rows
  }

}

/** Keep the first spelling of each group name, drop blanks and case-twins. */
export function dedupeGroups(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = name.toLowerCase()
    if (!name || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function normalizeLayout(record: Record<string, unknown>): SavedLayout | null {
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const snapshot = record.snapshot
  if (!name || !snapshot || typeof snapshot !== 'object') return null
  const now = Date.now()
  return {
    name,
    group: typeof record.group === 'string' ? record.group : '',
    snapshot: storedSnapshot(snapshot as WorkspaceLayoutSnapshot),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    modifiedAt: typeof record.modifiedAt === 'number' ? record.modifiedAt : now
  }
}
