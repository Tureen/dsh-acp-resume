/**
 * Per-session role rosters (D27): which chat instantiates which workspace role
 * for which DSH session. Rosters are keyed by `ownerSessionId`; a role resolves
 * only within its own session, and one session holds at most one chat per
 * role. The table is persisted through a {@link RosterStore} — the pool's
 * registry file, as its `rosters` section — so every change is one atomic
 * registry write. A malformed section reads as an empty table. Instances only:
 * blueprints live in the workspace team file.
 *
 * @module dsh-acp-resume/roster
 */

/** One instantiated role. */
export interface RosterEntry {
  readonly role: string
  readonly chatId: string
  readonly backend: string
}

/** The persisted `rosters` section: owner session id → its entries. */
export type RosterTable = Readonly<Record<string, { readonly entries: readonly RosterEntry[] }>>

/** Where the table lives; `writeRosters` must persist before it returns, or throw. */
export interface RosterStore {
  readRosters(): unknown
  writeRosters(next: RosterTable): void
}

/** Normalize a stored section; anything malformed reads as empty (entries that are not well-formed are dropped). */
export function toRosterTable(value: unknown): RosterTable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const table: Record<string, { entries: RosterEntry[] }> = {}
  for (const [owner, roster] of Object.entries(value)) {
    const entries: unknown = typeof roster === 'object' && roster !== null ? Reflect.get(roster, 'entries') : undefined
    if (!Array.isArray(entries)) continue
    const valid = entries.filter((e): e is RosterEntry => typeof e === 'object' && e !== null
      && typeof Reflect.get(e, 'role') === 'string' && typeof Reflect.get(e, 'chatId') === 'string' && typeof Reflect.get(e, 'backend') === 'string')
    table[owner] = { entries: valid.map(({ role, chatId, backend }) => ({ role, chatId, backend })) }
  }
  return table
}

export class Roster {
  constructor(private readonly store: RosterStore) {}

  private table(): RosterTable {
    return toRosterTable(this.store.readRosters())
  }

  /** The session's entries, in registration order. */
  list(ownerSessionId: string): readonly RosterEntry[] {
    return this.table()[ownerSessionId]?.entries ?? []
  }

  /** The chat instantiating `role` for this session, if any. */
  resolve(role: string, ownerSessionId: string): RosterEntry | undefined {
    return this.list(ownerSessionId).find(entry => entry.role === role)
  }

  /** The role a chat plays: in `ownerSessionId`'s roster, or in any roster when the owner is unknown. */
  roleOf(chatId: string, ownerSessionId?: string): string | undefined {
    const owners = ownerSessionId === undefined ? Object.values(this.table()) : [this.table()[ownerSessionId]]
    for (const roster of owners) {
      const entry = roster?.entries.find(e => e.chatId === chatId)
      if (entry !== undefined) return entry.role
    }
    return undefined
  }

  /** Bind `role` to `chatId` in this session's roster, replacing any previous binding of the role. */
  register(role: string, chatId: string, backend: string, ownerSessionId: string): void {
    const entries = this.list(ownerSessionId).filter(entry => entry.role !== role)
    this.write(ownerSessionId, [...entries, { role, chatId, backend }])
  }

  /** Unbind `role` in this session; true when a binding existed. */
  remove(role: string, ownerSessionId: string): boolean {
    const entries = this.list(ownerSessionId)
    const next = entries.filter(entry => entry.role !== role)
    if (next.length === entries.length) return false
    this.write(ownerSessionId, next)
    return true
  }

  /** Drop every binding to `chatId` in every session (the chat's record is gone). */
  removeChat(chatId: string): void {
    const table = this.table()
    if (!Object.values(table).some(r => r.entries.some(e => e.chatId === chatId))) return
    const next: Record<string, { entries: readonly RosterEntry[] }> = {}
    for (const [owner, roster] of Object.entries(table)) {
      const entries = roster.entries.filter(e => e.chatId !== chatId)
      if (entries.length > 0) next[owner] = { entries }
    }
    this.store.writeRosters(next)
  }

  private write(ownerSessionId: string, entries: readonly RosterEntry[]): void {
    const next: Record<string, { entries: readonly RosterEntry[] }> = { ...this.table() }
    if (entries.length === 0) delete next[ownerSessionId]
    else next[ownerSessionId] = { entries }
    this.store.writeRosters(next)
  }
}
