import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The phone events waiting for the backend (PGW-28). A SQLite table on the gateway's own disk: an event is
 * committed the moment it is recorded, needs no network to be kept, and leaves the queue only by its own ID
 * once the backend accepted it. Spec: docs/features/phone-gateway.md, PGW-40.
 */

export interface QueuedEvent { id: string; [field: string]: unknown }
export interface Batch { phone: string; events: QueuedEvent[] }

const BATCH = 50
const MAX_BACKOFF_MS = 5 * 60_000
// A batch the backend refuses goes one by one; an event refused this many times (its batch counts once) is set aside.
const PARK_AFTER_REFUSALS = 3

export class EventQueue {
  private readonly db: DatabaseSync

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        phone TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        refusals INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS events_queued ON events (status, phone, seq);
    `)
  }

  /** Recording the same event twice keeps one. */
  add(phone: string, event: QueuedEvent, now = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO events (id, phone, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(event.id, phone, JSON.stringify(event), now)
  }

  /**
   * The next batch: the phone whose oldest waiting event is the oldest of all and due. Its events go in the
   * order they were recorded; while its first event is retried after a refusal, it goes alone.
   */
  next(now = Date.now()): Batch | undefined {
    const heads = this.db.prepare(`SELECT phone, refusals, next_attempt_at FROM events e WHERE status = 'queued'
      AND seq = (SELECT MIN(seq) FROM events WHERE status = 'queued' AND phone = e.phone) ORDER BY seq`).all() as Array<{ phone: string; refusals: number; next_attempt_at: number }>
    const head = heads.find(item => item.next_attempt_at <= now)
    if (!head) return undefined
    const rows = this.db.prepare(`SELECT payload FROM events WHERE status = 'queued' AND phone = ? ORDER BY seq LIMIT ?`)
      .all(head.phone, head.refusals > 0 ? 1 : BATCH) as Array<{ payload: string }>
    return { phone: head.phone, events: rows.map(row => JSON.parse(row.payload) as QueuedEvent) }
  }

  /** Accepted by the backend: only these IDs leave the queue. */
  sent(ids: string[], now = Date.now()): void {
    const mark = this.db.prepare(`UPDATE events SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`)
    this.transaction(() => { for (const id of ids) mark.run(now, id) })
  }

  /**
   * Not delivered. A network error or a 5xx is the backend being away: retried with growing pauses, never set
   * aside. A refusal (4xx) is about the events: retried one by one, and one event refused alone again is parked.
   * Returns the IDs set aside.
   */
  failed(ids: string[], error: string, refused: boolean, now = Date.now()): string[] {
    const [head] = ids
    if (!head) return []
    const row = this.db.prepare('SELECT attempts, refusals FROM events WHERE id = ?').get(head) as { attempts: number; refusals: number } | undefined
    if (!row) return []
    const attempts = row.attempts + 1
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 20))
    if (!refused) {
      // Only the first event decides when this phone is tried again (next() looks at it alone).
      this.db.prepare('UPDATE events SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, now + backoff, error, head)
      return []
    }
    if (ids.length > 1) {
      // A refused batch is split: its first event goes alone at once, and the rest follow it.
      this.db.prepare('UPDATE events SET attempts = ?, refusals = 1, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, now, error, head)
      return []
    }
    const refusals = row.refusals + 1
    if (refusals >= PARK_AFTER_REFUSALS) {
      this.db.prepare(`UPDATE events SET status = 'parked', attempts = ?, refusals = ?, last_error = ? WHERE id = ?`).run(attempts, refusals, error, head)
      return [head]
    }
    this.db.prepare('UPDATE events SET attempts = ?, refusals = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, refusals, now + backoff, error, head)
    return []
  }

  /** Parked events go back to the queue, e.g. after a backend fix. */
  requeueParked(): number {
    return Number(this.db.prepare(`UPDATE events SET status = 'queued', refusals = 0, next_attempt_at = 0 WHERE status = 'parked'`).run().changes)
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status').all() as Array<{ status: string; n: number }>
    return Object.fromEntries(rows.map(row => [row.status, Number(row.n)]))
  }

  /** Sent events are kept for a while for investigation; waiting and parked ones are never pruned. */
  prune(olderThanMs: number, now = Date.now()): void {
    this.db.prepare(`DELETE FROM events WHERE status = 'sent' AND sent_at < ?`).run(now - olderThanMs)
  }

  /** The earlier JSON-file outbox, imported once in its order, then renamed so it is not imported again. */
  importLegacy(file: string): number {
    if (!existsSync(file)) return 0
    const items = JSON.parse(readFileSync(file, 'utf8') || '[]') as Array<{ phone: string; event: QueuedEvent }>
    this.transaction(() => { for (const item of items) this.add(item.phone, item.event) })
    renameSync(file, `${file}.imported`)
    return items.length
  }

  close(): void { this.db.close() }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { work(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
