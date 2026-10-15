import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { audit, type Actor } from '../audit.js'
import { sha256 } from '../auth.js'
import type { Deps } from '../context.js'
import type { TenantContext } from '../db.js'
import { clientIp, HttpError, notFound, parse } from '../http.js'
import { PLANS, type Plan } from '../plans.js'
import { createPost, getPost, POST_COLUMNS, setStatus, STATUSES } from '../posts.js'
import { setRateHeaders } from '../ratelimit.js'
import { consume } from '../usage.js'

interface ApiKeyContext {
  keyId: string
  keyName: string
  orgId: string
  plan: Plan
}

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKeyContext
  }
}

function serialize(p: Record<string, any>) {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    status: p.status,
    tags: p.tags,
    votes: p.vote_count,
    comments: p.comment_count,
    author: p.author_name,
    board: { id: p.board_id, name: p.board_name, slug: p.board_slug },
    mergedIntoId: p.merged_into_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }
}

/** Public REST API, authenticated with an org API key: `Authorization: Bearer tly_live_…`. */
export function apiV1Routes(deps: Deps): Router {
  const r = Router()
  const { db } = deps

  const ctx = (req: Request): TenantContext => ({ orgId: req.apiKey!.orgId })
  const keyActor = (req: Request): Actor => ({ type: 'api_key', id: req.apiKey!.keyId, label: `API key: ${req.apiKey!.keyName}` })

  async function authenticate(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization ?? ''
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!key.startsWith('tly_live_')) throw new HttpError(401, 'unauthenticated', 'Send an API key: Authorization: Bearer tly_live_…')
    const keyHash = sha256(key)

    // Resolve the key by presenting its hash (policy api_key_read), then work inside its org.
    const found = await db.tx({ apiKeyHash: keyHash }, async (c) => {
      const { rows } = await c.query<{ id: string; name: string; org_id: string; plan: Plan; last_used_at: Date | null }>(
        `SELECT k.id, k.name, k.org_id, o.plan, k.last_used_at
           FROM api_keys k JOIN organizations o ON o.id = k.org_id
          WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
        [keyHash],
      )
      return rows[0]
    })
    if (!found) throw new HttpError(401, 'invalid_api_key', 'This API key is invalid or was revoked.')

    const plan = PLANS[found.plan]
    if (plan.apiCallsPerMonth === 0) throw new HttpError(402, 'plan_required', 'API access needs the Pro or Business plan.')

    const rate = deps.limiter.hit(`api:${found.id}`, plan.apiRequestsPerMinute)
    setRateHeaders(res, rate)
    if (!rate.allowed) {
      res.setHeader('Retry-After', rate.resetSeconds)
      throw new HttpError(429, 'rate_limited', `Rate limit is ${plan.apiRequestsPerMinute} requests per minute on the ${plan.name} plan.`)
    }

    const withinQuota = await db.tx({ orgId: found.org_id }, async (c) => {
      const ok = await consume(c, found.org_id, 'api_calls', plan.apiCallsPerMonth)
      // Recording last use on every call would write on every request; once a minute is plenty.
      if (ok && (!found.last_used_at || Date.now() - found.last_used_at.getTime() > 60_000)) {
        await c.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [found.id])
      }
      return ok
    })
    if (!withinQuota) {
      throw new HttpError(429, 'usage_limit', `This organization used its ${plan.apiCallsPerMonth.toLocaleString('en-US')} API calls for this month.`)
    }

    req.apiKey = { keyId: found.id, keyName: found.name, orgId: found.org_id, plan: found.plan }
    next()
  }

  r.use(authenticate)

  r.get('/boards', async (req, res) => {
    const boards = await db.tx(ctx(req), async (c) => {
      const { rows } = await c.query('SELECT id, name, slug, is_public AS "isPublic", created_at AS "createdAt" FROM boards ORDER BY created_at')
      return rows
    })
    res.json({ data: boards })
  })

  r.get('/posts', async (req, res) => {
    const q = parse(
      z.object({
        board: z.string().optional(),
        status: z.enum(STATUSES).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        before: z.coerce.number().int().optional(),
      }),
      req.query,
    )
    const posts = await db.tx(ctx(req), async (c) => {
      const where = ['p.merged_into_id IS NULL']
      const args: unknown[] = []
      if (q.board) where.push(`(b.slug = $${args.push(q.board)} OR b.id::text = $${args.length})`)
      if (q.status) where.push(`p.status = $${args.push(q.status)}`)
      if (q.before) where.push(`p.number < $${args.push(q.before)}`)
      const { rows } = await c.query(
        `SELECT ${POST_COLUMNS} FROM posts p JOIN boards b ON b.id = p.board_id
          WHERE ${where.join(' AND ')} ORDER BY p.number DESC LIMIT ${q.limit + 1}`,
        args,
      )
      return rows
    })
    const page = posts.slice(0, q.limit)
    res.json({ data: page.map(serialize), nextBefore: posts.length > q.limit ? page[page.length - 1].number : null })
  })

  r.get('/posts/:number', async (req, res) => {
    const number = Number(req.params.number)
    if (!Number.isInteger(number)) throw notFound('Post not found.')
    const post = await db.tx(ctx(req), (c) => getPost(c, { number }))
    res.json({ data: serialize(post) })
  })

  r.post('/posts', async (req, res) => {
    const body = parse(
      z.object({
        board: z.string().min(1),
        title: z.string().trim().min(3).max(140),
        body: z.string().trim().max(5000).default(''),
        authorName: z.string().trim().min(1).max(60).default('API'),
      }),
      req.body,
    )
    const post = await db.tx(ctx(req), async (c) => {
      const board = await c.query('SELECT id FROM boards WHERE slug = $1 OR id::text = $1', [body.board])
      if (!board.rows[0]) throw notFound(`Board "${body.board}" not found.`)
      const created = await createPost(c, req.apiKey!.orgId, {
        boardId: board.rows[0].id,
        title: body.title,
        body: body.body,
        authorId: null,
        authorName: body.authorName,
      })
      await audit(c, { orgId: req.apiKey!.orgId, actor: keyActor(req), action: 'post.created', target: body.title, ip: clientIp(req) })
      return getPost(c, { id: created.id })
    })
    res.status(201).json({ data: serialize(post) })
  })

  r.patch('/posts/:number', async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(STATUSES).optional(),
        tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10).optional(),
      }),
      req.body,
    )
    const post = await db.tx(ctx(req), async (c) => {
      const current = await getPost(c, { number: Number(req.params.number) })
      if (body.status) {
        const change = await setStatus(c, req.apiKey!.orgId, current.id, body.status, null)
        if (change.changed) {
          await audit(c, {
            orgId: req.apiKey!.orgId,
            actor: keyActor(req),
            action: 'post.status_changed',
            target: current.title,
            ip: clientIp(req),
            metadata: { from: change.from, to: change.to },
          })
        }
      }
      if (body.tags) await c.query('UPDATE posts SET tags = $2, updated_at = now() WHERE id = $1', [current.id, [...new Set(body.tags)]])
      return getPost(c, { id: current.id })
    })
    res.json({ data: serialize(post) })
  })

  r.use((_req: Request) => {
    throw new HttpError(404, 'not_found', 'Unknown API endpoint. See the README for the API reference.')
  })

  return r
}
