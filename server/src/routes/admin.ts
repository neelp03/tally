import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../audit.js'
import { sha256 } from '../auth.js'
import { actor, orgAccess, tenant, type Deps } from '../context.js'
import { clientIp, forbidden, HttpError, notFound, parse } from '../http.js'
import { PLANS, type Plan } from '../plans.js'

const KEY_PREFIX = 'tly_live_'
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function newApiKey(): string {
  const bytes = randomBytes(32)
  let out = ''
  for (const b of bytes) out += BASE62[b % 62]
  return KEY_PREFIX + out
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value)
  // Neutralize spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

/** API keys, audit log, and the platform-wide admin view. */
export function adminRoutes(deps: Deps): Router {
  const r = Router()
  const { db } = deps

  // API keys

  r.get('/orgs/:orgId/api-keys', orgAccess(deps, 'apikeys.manage'), async (req, res) => {
    const keys = await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query(
        `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, u.name AS created_by
           FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
          WHERE k.revoked_at IS NULL ORDER BY k.created_at DESC`,
      )
      return rows
    })
    const plan = PLANS[req.org!.plan]
    res.json({ keys, apiEnabled: plan.apiCallsPerMonth > 0, ratePerMinute: plan.apiRequestsPerMinute })
  })

  r.post('/orgs/:orgId/api-keys', orgAccess(deps, 'apikeys.manage'), async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body)
    if (PLANS[req.org!.plan].apiCallsPerMonth === 0) {
      throw new HttpError(402, 'plan_required', 'API access needs the Pro or Business plan.')
    }
    const key = newApiKey()
    const created = await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query(
        `INSERT INTO api_keys (org_id, name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, prefix, created_at`,
        [req.org!.id, name, key.slice(0, KEY_PREFIX.length + 4), sha256(key), req.user!.id],
      )
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'api_key.created', target: name, ip: clientIp(req) })
      return rows[0]
    })
    // The only time the full key leaves the server; we store its hash.
    res.status(201).json({ key: created, secret: key })
  })

  r.delete('/orgs/:orgId/api-keys/:keyId', orgAccess(deps, 'apikeys.manage'), async (req, res) => {
    await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING name', [
        req.params.keyId,
      ])
      if (!rows[0]) throw notFound('API key not found.')
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'api_key.revoked', target: rows[0].name, ip: clientIp(req) })
    })
    res.status(204).end()
  })

  // Audit log

  const auditQuery = z.object({
    actor: z.string().max(100).optional(),
    action: z.string().max(60).optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().optional(),
  })

  async function queryAudit(req: Parameters<typeof tenant>[0], q: z.infer<typeof auditQuery>, limit: number) {
    return db.tx(tenant(req), async (c) => {
      const where = [`created_at > now() - make_interval(days => $1)`]
      const args: unknown[] = [q.days]
      if (q.actor) where.push(`actor_label = $${args.push(q.actor)}`)
      if (q.action) where.push(`action = $${args.push(q.action)}`)
      if (q.before) where.push(`id < $${args.push(q.before)}`)
      const { rows } = await c.query(
        `SELECT id, created_at, actor_type, actor_label, action, target_label, host(ip) AS ip, metadata
           FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`,
        args,
      )
      return rows
    })
  }

  r.get('/orgs/:orgId/audit-log', orgAccess(deps, 'audit.read'), async (req, res) => {
    const q = parse(auditQuery, req.query)
    const rows = await queryAudit(req, q, q.limit + 1)
    const facets = await db.tx(tenant(req), async (c) => {
      const actors = await c.query('SELECT DISTINCT actor_label FROM audit_logs ORDER BY 1 LIMIT 100')
      const actions = await c.query('SELECT DISTINCT action FROM audit_logs ORDER BY 1 LIMIT 100')
      return { actors: actors.rows.map((x) => x.actor_label), actions: actions.rows.map((x) => x.action) }
    })
    res.json({
      entries: rows.slice(0, q.limit),
      nextBefore: rows.length > q.limit ? rows[q.limit - 1].id : null,
      facets,
      canExport: PLANS[req.org!.plan].auditExport,
    })
  })

  r.get('/orgs/:orgId/audit-log.csv', orgAccess(deps, 'audit.read'), async (req, res) => {
    if (!PLANS[req.org!.plan].auditExport) throw new HttpError(402, 'plan_required', 'Audit log export needs the Business plan.')
    const q = parse(auditQuery, req.query)
    const rows = await queryAudit(req, q, 10_000)
    const header = ['time', 'actor_type', 'actor', 'action', 'target', 'ip', 'metadata']
    const lines = rows.map((x) =>
      [x.created_at, x.actor_type, x.actor_label, x.action, x.target_label, x.ip, JSON.stringify(x.metadata)].map(csvCell).join(','),
    )
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${req.org!.slug}-audit-log.csv"`)
    res.send([header.join(','), ...lines].join('\n') + '\n')
  })

  // Platform admin: across all tenants, but only from the organizations table,
  // which holds no customer content (see the org_read policy).

  r.get('/admin/orgs', async (req, res) => {
    if (!req.user?.is_platform_admin) throw forbidden('Platform admins only.')
    const { rows } = await db.pool.query(
      `SELECT id, name, slug, plan, subscription_status, created_at, is_demo,
              CASE WHEN usage_period_start < date_trunc('month', now())::date THEN 0 ELSE posts_this_period END AS posts_this_period,
              CASE WHEN usage_period_start < date_trunc('month', now())::date THEN 0 ELSE api_calls_this_period END AS api_calls_this_period
         FROM organizations ORDER BY created_at DESC LIMIT 500`,
    )
    const orgs = rows.map((o) => ({ ...o, mrr: PLANS[o.plan as Plan].priceMonthly }))
    const byPlan = { free: 0, pro: 0, business: 0 } as Record<Plan, number>
    for (const o of orgs) byPlan[o.plan as Plan]++
    res.json({
      orgs,
      totals: { orgs: orgs.length, mrr: orgs.reduce((sum, o) => sum + (o.is_demo ? 0 : o.mrr), 0), byPlan },
    })
  })

  return r
}
