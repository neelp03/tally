import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../audit.js'
import { actor, orgAccess, tenant, type Deps } from '../context.js'
import { clientIp, HttpError, notFound, parse } from '../http.js'
import { addComment, createPost, getPost, mergePost, POST_COLUMNS, setStatus, STATUSES } from '../posts.js'

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  board: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['votes', 'new']).default('votes'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export function postRoutes(deps: Deps): Router {
  const r = Router()
  const { db } = deps

  r.get('/orgs/:orgId/posts', orgAccess(deps, 'posts.read'), async (req, res) => {
    const q = parse(listQuery, req.query)
    const result = await db.tx(tenant(req), async (c) => {
      const where = ['p.merged_into_id IS NULL']
      const args: unknown[] = []
      if (q.status) where.push(`p.status = $${args.push(q.status)}`)
      if (q.board) where.push(`p.board_id = $${args.push(q.board)}`)
      if (q.q) where.push(`(p.title ILIKE $${args.push(`%${q.q}%`)} OR p.body ILIKE $${args.length})`)
      const order = q.sort === 'new' ? 'p.created_at DESC' : 'p.vote_count DESC, p.created_at DESC'
      const { rows } = await c.query(
        `SELECT ${POST_COLUMNS}, count(*) OVER () AS total
           FROM posts p JOIN boards b ON b.id = p.board_id
          WHERE ${where.join(' AND ')}
          ORDER BY ${order} LIMIT ${q.limit} OFFSET ${q.offset}`,
        args,
      )
      const counts = await c.query(
        `SELECT status, count(*)::int AS n FROM posts WHERE merged_into_id IS NULL ${q.board ? 'AND board_id = $1' : ''} GROUP BY status`,
        q.board ? [q.board] : [],
      )
      return { rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) }
    })
    res.json({
      posts: result.rows.map(({ total, ...p }) => p),
      total: Number(result.rows[0]?.total ?? 0),
      statusCounts: result.counts,
    })
  })

  r.post('/orgs/:orgId/posts', orgAccess(deps, 'posts.triage'), async (req, res) => {
    const body = parse(
      z.object({ boardId: z.string().uuid(), title: z.string().trim().min(3).max(140), body: z.string().trim().max(5000).default('') }),
      req.body,
    )
    const post = await db.tx(tenant(req), async (c) => {
      const created = await createPost(c, req.org!.id, { ...body, authorId: req.user!.id, authorName: req.user!.name })
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'post.created', target: body.title, ip: clientIp(req) })
      return getPost(c, { id: created.id })
    })
    res.status(201).json({ post })
  })

  r.get('/orgs/:orgId/posts/:postId', orgAccess(deps, 'posts.read'), async (req, res) => {
    const data = await db.tx(tenant(req), async (c) => {
      const post = await getPost(c, { id: String(req.params.postId) })
      const comments = await c.query(
        `SELECT id, author_name, body, is_team, is_internal, created_at FROM comments WHERE post_id = $1 ORDER BY created_at`,
        [post.id],
      )
      const voters = await c.query(
        `SELECT COALESCE(voter_name, 'Anonymous') AS name, created_at FROM votes WHERE post_id = $1 ORDER BY created_at DESC LIMIT 8`,
        [post.id],
      )
      const history = await c.query(
        `SELECT s.from_status, s.to_status, s.created_at, u.name AS changed_by
           FROM status_changes s LEFT JOIN users u ON u.id = s.changed_by
          WHERE s.post_id = $1 ORDER BY s.created_at`,
        [post.id],
      )
      return { post, comments: comments.rows, voters: voters.rows, history: history.rows }
    })
    res.json(data)
  })

  r.patch('/orgs/:orgId/posts/:postId', orgAccess(deps, 'posts.triage'), async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(STATUSES).optional(),
        tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10).optional(),
        title: z.string().trim().min(3).max(140).optional(),
        body: z.string().trim().max(5000).optional(),
        boardId: z.string().uuid().optional(),
      }),
      req.body,
    )
    const post = await db.tx(tenant(req), async (c) => {
      const current = await getPost(c, { id: String(req.params.postId) })
      if (body.status) {
        const change = await setStatus(c, req.org!.id, current.id, body.status, req.user!.id)
        if (change.changed) {
          await audit(c, {
            orgId: req.org!.id,
            actor: actor(req),
            action: 'post.status_changed',
            target: current.title,
            ip: clientIp(req),
            metadata: { from: change.from, to: change.to },
          })
        }
      }
      if (body.tags || body.title || body.body !== undefined || body.boardId) {
        await c.query(
          `UPDATE posts SET tags = COALESCE($2, tags), title = COALESCE($3, title), body = COALESCE($4, body),
                            board_id = COALESCE($5, board_id), updated_at = now()
            WHERE id = $1`,
          [current.id, body.tags ? [...new Set(body.tags)] : null, body.title ?? null, body.body ?? null, body.boardId ?? null],
        )
        await audit(c, {
          orgId: req.org!.id,
          actor: actor(req),
          action: 'post.updated',
          target: current.title,
          ip: clientIp(req),
          metadata: { fields: Object.keys(body).filter((k) => k !== 'status') },
        })
      }
      return getPost(c, { id: current.id })
    })
    res.json({ post })
  })

  r.post('/orgs/:orgId/posts/:postId/merge', orgAccess(deps, 'posts.triage'), async (req, res) => {
    const { intoId } = parse(z.object({ intoId: z.string().uuid() }), req.body)
    const fromId = String(req.params.postId)
    if (intoId === fromId) throw new HttpError(400, 'invalid_request', 'A post cannot be merged into itself.')
    const post = await db.tx(tenant(req), async (c) => {
      const from = await getPost(c, { id: fromId })
      const into = await getPost(c, { id: intoId })
      if (from.merged_into_id) throw new HttpError(409, 'already_merged', 'This post was already merged.')
      await mergePost(c, req.org!.id, from.id, into.id, req.user!.id)
      await audit(c, {
        orgId: req.org!.id,
        actor: actor(req),
        action: 'post.merged',
        target: `${from.title} → ${into.title}`,
        ip: clientIp(req),
      })
      return getPost(c, { id: into.id })
    })
    res.json({ post })
  })

  r.post('/orgs/:orgId/posts/:postId/comments', orgAccess(deps, 'posts.triage'), async (req, res) => {
    const body = parse(z.object({ body: z.string().trim().min(1).max(5000), internal: z.boolean().default(false) }), req.body)
    const comment = await db.tx(tenant(req), async (c) => {
      const post = await getPost(c, { id: String(req.params.postId) })
      return addComment(c, req.org!.id, post.id, {
        authorId: req.user!.id,
        authorName: req.user!.name,
        body: body.body,
        isTeam: true,
        isInternal: body.internal,
      })
    })
    res.status(201).json({ comment })
  })

  r.delete('/orgs/:orgId/posts/:postId', orgAccess(deps, 'posts.delete'), async (req, res) => {
    await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query('DELETE FROM posts WHERE id = $1 RETURNING title', [req.params.postId])
      if (!rows[0]) throw notFound('Post not found.')
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'post.deleted', target: rows[0].title, ip: clientIp(req) })
    })
    res.status(204).end()
  })

  return r
}
