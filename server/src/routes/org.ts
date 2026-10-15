import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../audit.js'
import { actor, orgAccess, tenant, type Deps } from '../context.js'
import { clientIp, HttpError, notFound, parse } from '../http.js'
import { createOrg, slugify } from '../orgs.js'
import { PLANS } from '../plans.js'
import { assertBoardAvailable, usageSummary } from '../usage.js'

export function orgRoutes(deps: Deps): Router {
  const r = Router()
  const { db } = deps

  r.post('/orgs', async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body)
    const org = await db.tx({ userId: req.user!.id }, (c) => createOrg(c, req.user!, name, { ip: clientIp(req) }))
    res.status(201).json({ org })
  })

  r.get('/orgs/:orgId', orgAccess(deps), async (req, res) => {
    const data = await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query(
        `SELECT id, name, slug, plan, subscription_status, current_period_end, sso_domain, is_demo
           FROM organizations WHERE id = $1`,
        [req.org!.id],
      )
      return { ...rows[0], usage: await usageSummary(c, req.org!.id) }
    })
    res.json({ org: { ...data, role: req.org!.role, limits: PLANS[req.org!.plan] }, plans: PLANS, billingMode: deps.billing.mode })
  })

  r.patch('/orgs/:orgId', orgAccess(deps, 'org.manage'), async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        ssoDomain: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/, 'must be a domain like example.com')
          .nullable()
          .optional(),
      }),
      req.body,
    )
    if (body.ssoDomain && !PLANS[req.org!.plan].ssoDomain) {
      throw new HttpError(402, 'plan_required', 'Sign-in by email domain needs the Business plan.')
    }
    await db.tx(tenant(req), async (c) => {
      if (body.name !== undefined) await c.query('UPDATE organizations SET name = $2 WHERE id = $1', [req.org!.id, body.name])
      if (body.ssoDomain !== undefined) {
        await c.query('UPDATE organizations SET sso_domain = $2 WHERE id = $1', [req.org!.id, body.ssoDomain])
      }
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'organization.updated', ip: clientIp(req), metadata: body })
    })
    res.json({ ok: true })
  })

  r.get('/orgs/:orgId/overview', orgAccess(deps), async (req, res) => {
    const data = await db.tx(tenant(req), async (c) => {
      const stats = await c.query(
        `SELECT
           (SELECT count(*) FROM posts WHERE merged_into_id IS NULL AND status NOT IN ('shipped', 'closed')) AS open_posts,
           (SELECT count(*) FROM posts WHERE created_at > now() - interval '7 days') AS new_this_week,
           (SELECT count(*) FROM posts WHERE created_at BETWEEN now() - interval '14 days' AND now() - interval '7 days') AS new_last_week,
           (SELECT count(*) FROM votes WHERE created_at > now() - interval '7 days') AS votes_this_week,
           (SELECT count(*) FROM votes WHERE created_at BETWEEN now() - interval '14 days' AND now() - interval '7 days') AS votes_last_week,
           (SELECT count(*) FROM status_changes WHERE to_status = 'shipped' AND created_at > date_trunc('month', now())) AS shipped_this_month`,
      )
      const top = await c.query(
        `SELECT p.id, p.number, p.title, p.status, p.vote_count FROM posts p
          WHERE p.merged_into_id IS NULL AND p.status NOT IN ('shipped', 'closed')
          ORDER BY p.vote_count DESC, p.created_at DESC LIMIT 5`,
      )
      // One feed from three sources, newest first.
      const activity = await c.query(
        `(SELECT 'post' AS kind, p.created_at AS at, p.author_name AS who, p.title, p.number, NULL AS detail
            FROM posts p ORDER BY p.created_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'status', s.created_at, COALESCE(u.name, 'API'), p.title, p.number, s.to_status
            FROM status_changes s JOIN posts p ON p.id = s.post_id LEFT JOIN users u ON u.id = s.changed_by
           WHERE s.from_status IS NOT NULL ORDER BY s.created_at DESC LIMIT 10)
         UNION ALL
         (SELECT 'comment', cm.created_at, cm.author_name, p.title, p.number, left(cm.body, 140)
            FROM comments cm JOIN posts p ON p.id = cm.post_id ORDER BY cm.created_at DESC LIMIT 10)
         ORDER BY at DESC LIMIT 8`,
      )
      return { stats: stats.rows[0], top: top.rows, activity: activity.rows, usage: await usageSummary(c, req.org!.id) }
    })
    const s = data.stats
    res.json({
      stats: {
        openPosts: Number(s.open_posts),
        newThisWeek: Number(s.new_this_week),
        newLastWeek: Number(s.new_last_week),
        votesThisWeek: Number(s.votes_this_week),
        votesLastWeek: Number(s.votes_last_week),
        shippedThisMonth: Number(s.shipped_this_month),
      },
      top: data.top,
      activity: data.activity,
      usage: data.usage,
    })
  })

  // boards

  r.get('/orgs/:orgId/boards', orgAccess(deps), async (req, res) => {
    const boards = await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query(
        `SELECT b.id, b.name, b.slug, b.is_public, b.created_at,
                (SELECT count(*)::int FROM posts p WHERE p.board_id = b.id AND p.merged_into_id IS NULL) AS post_count
           FROM boards b ORDER BY b.created_at`,
      )
      return rows
    })
    res.json({ boards })
  })

  const boardBody = z.object({
    name: z.string().trim().min(1).max(60),
    isPublic: z.boolean().default(true),
  })

  r.post('/orgs/:orgId/boards', orgAccess(deps, 'boards.manage'), async (req, res) => {
    const body = parse(boardBody, req.body)
    const board = await db.tx(tenant(req), async (c) => {
      await assertBoardAvailable(c, req.org!.id)
      let slug = slugify(body.name)
      const taken = await c.query('SELECT 1 FROM boards WHERE slug = $1', [slug])
      if (taken.rowCount) slug = `${slug}-${Date.now().toString(36).slice(-4)}`
      const { rows } = await c.query(
        'INSERT INTO boards (org_id, name, slug, is_public) VALUES ($1, $2, $3, $4) RETURNING id, name, slug, is_public',
        [req.org!.id, body.name, slug, body.isPublic],
      )
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'board.created', target: body.name, ip: clientIp(req) })
      return rows[0]
    })
    res.status(201).json({ board })
  })

  r.patch('/orgs/:orgId/boards/:boardId', orgAccess(deps, 'boards.manage'), async (req, res) => {
    const body = parse(boardBody.partial(), req.body)
    const board = await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query(
        `UPDATE boards SET name = COALESCE($2, name), is_public = COALESCE($3, is_public)
          WHERE id = $1 RETURNING id, name, slug, is_public`,
        [req.params.boardId, body.name ?? null, body.isPublic ?? null],
      )
      if (!rows[0]) throw notFound('Board not found.')
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'board.updated', target: rows[0].name, ip: clientIp(req), metadata: body })
      return rows[0]
    })
    res.json({ board })
  })

  r.delete('/orgs/:orgId/boards/:boardId', orgAccess(deps, 'boards.manage'), async (req, res) => {
    await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query('DELETE FROM boards WHERE id = $1 RETURNING name', [req.params.boardId])
      if (!rows[0]) throw notFound('Board not found.')
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'board.deleted', target: rows[0].name, ip: clientIp(req) })
    })
    res.status(204).end()
  })

  return r
}
