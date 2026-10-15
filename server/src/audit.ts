import type { Tx } from './db.js'

export type Actor =
  | { type: 'user'; id: string; label: string }
  | { type: 'api_key'; id: string; label: string }
  | { type: 'system'; label: string }

export interface AuditEntry {
  orgId: string
  actor: Actor
  action: string
  target?: string | null
  ip?: string | null
  metadata?: Record<string, unknown>
}

/** Append-only: the app never updates or deletes audit rows. */
export async function audit(c: Tx, entry: AuditEntry) {
  await c.query(
    `INSERT INTO audit_logs (org_id, actor_type, actor_id, actor_label, action, target_label, ip, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.orgId,
      entry.actor.type,
      entry.actor.type === 'system' ? null : entry.actor.id,
      entry.actor.label,
      entry.action,
      entry.target ?? null,
      entry.ip ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  )
}
