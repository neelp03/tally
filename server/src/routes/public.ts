import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { parseCookies, setCookie, VOTER_COOKIE } from '../auth.js'
import type { Deps } from '../context.js'
import type { Tx } from '../db.js'
import { HttpError, notFound, parse } from '../http.js'
import { addComment, createPost, getPost, toggleVote, STATUSES } from '../posts.js'
import { ipLimit } from '../ratelimit.js'

interface PublicOrg {
  id: string
  name: string
  slug: string
}

/**
 * Customer-facing board. No account needed: visitors are identified by a random
 * cookie for voting. Signed-in Tally users vote as themselves.
 */
export function publicRoutes(deps: Deps): Router {
  const r = Router()
  const { db } = deps
  const writeLimit = ipLimit(deps.limiter, 'public-write', 20)

  async function findOrg(slug: string): Promise<PublicOrg> {
    const { rows } = await db.pool.query<PublicOrg>('SELECT id, name, slug FROM organizations WHERE slug = $1', [slug])
    if (!rows[0]) throw notFound('Board not found.')
    return rows[0]
  }

  function voter(req: Request, res: Response): { key: string; name: string | null } {
    if (req.user) return { key: `user:${req.user.id}`, name: req.user.name }
    let id = parseCookies(req)[VOTER_COOKIE]
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
      id = randomUUID()
      setCookie(res, VOTER_COOKIE, id, { maxAgeMs: 365 * 24 * 60 * 60 * 1000, secure: deps.secureCookies })
    }
    return { key: `anon:${id}`, name: null }
  }

  /** In the org's context, but only public boards are reachable from here. */
  async function publicBoard(c: Tx, boardSlug: string) {
    const { rows } = await c.query('SELECT id, name, slug FROM boards WHERE slug = $1 AND is_public', [boardSlug])
    if (!rows[0]) throw notFound('Board not found.')
    return rows[0] as { id: string; name: string; slug: string }
  }

  async function publicPost(c: Tx, number: number) {
    const post = await getPost(c, { number })
    const board = await c.query('SELECT is_public FROM boards WHERE id = $1', [post.board_id])
    if (!board.rows[0]?.is_public) throw notFound('Post not found.')
    return post
  }

  r.get('/public/orgs/:slug', async (req, res) => {
    const org = await findOrg(String(req.params.slug))
    const boards = await db.tx({ orgId: org.id }, async (c) => {
      const { rows } = await c.query('SELECT name, slug FROM boards WHERE is_public ORDER BY created_at')
      return rows
    })
    res.json({ org: { name: org.name, slug: org.slug }, boards })
  })

  r.get('/public/orgs/:slug/boards/:board/posts', async (req, res) => {
    const q = parse(
      z.object({ sort: z.enum(['trending', 'top', 'new']).default('trending'), status: z.enum(STATUSES).optional() }),
      req.query,
    )
    const org = await findOrg(String(req.params.slug))
    const me = voter(req, res)
    const posts = await db.tx({ orgId: org.id }, async (c) => {
      const board = await publicBoard(c, String(req.params.board))
      const order = {
        trending: `p.vote_count / power(extract(epoch FROM now() - p.created_at) / 3600 + 2, 1.5) DESC`,
        top: 'p.vote_count DESC, p.created_at DESC',
        new: 'p.created_at DESC',
      }[q.sort]
      const args: unknown[] = [board.id, me.key]
      const { rows } = await c.query(
        `SELECT p.number, p.title, left(p.body, 280) AS excerpt, p.status, p.vote_count, p.comment_count, p.created_at,
                EXISTS (SELECT 1 FROM votes v WHERE v.post_id = p.id AND v.voter_key = $2) AS voted
           FROM posts p
          WHERE p.board_id = $1 AND p.merged_into_id IS NULL ${q.status ? `AND p.status = $${args.push(q.status)}` : ''}
          ORDER BY ${order} LIMIT 100`,
        args,
      )
      return rows
    })
    res.json({ posts })
  })

  r.post('/public/orgs/:slug/boards/:board/posts', writeLimit, async (req, res) => {
    const body = parse(
      z.object({
        title: z.string().trim().min(3).max(140),
        body: z.string().trim().max(5000).default(''),
        name: z.string().trim().max(60).optional(),
      }),
      req.body,
    )
    const org = await findOrg(String(req.params.slug))
    const me = voter(req, res)
    const post = await db.tx({ orgId: org.id }, async (c) => {
      const board = await publicBoard(c, String(req.params.board))
      const created = await createPost(c, org.id, {
        boardId: board.id,
        title: body.title,
        body: body.body,
        authorId: req.user?.id ?? null,
        authorName: req.user?.name ?? (body.name || 'Anonymous'),
      })
      // Posting an idea counts as voting for it.
      await toggleVote(c, org.id, created.id, me.key, me.name ?? body.name ?? null)
      return created
    })
    res.status(201).json({ post })
  })

  r.get('/public/orgs/:slug/posts/:number', async (req, res) => {
    const number = Number(req.params.number)
    if (!Number.isInteger(number)) throw notFound('Post not found.')
    const org = await findOrg(String(req.params.slug))
    const me = voter(req, res)
    const data = await db.tx({ orgId: org.id }, async (c) => {
      let post = await publicPost(c, number)
      // A merged duplicate forwards to the post it was merged into.
      if (post.merged_into_id) post = await getPost(c, { id: post.merged_into_id })
      const comments = await c.query(
        `SELECT author_name, body, is_team, created_at FROM comments WHERE post_id = $1 AND NOT is_internal ORDER BY created_at`,
        [post.id],
      )
      const history = await c.query('SELECT to_status, created_at FROM status_changes WHERE post_id = $1 ORDER BY created_at', [post.id])
      const voted = await c.query('SELECT 1 FROM votes WHERE post_id = $1 AND voter_key = $2', [post.id, me.key])
      return {
        post: {
          number: post.number,
          title: post.title,
          body: post.body,
          status: post.status,
          vote_count: post.vote_count,
          comment_count: post.comment_count,
          author_name: post.author_name,
          created_at: post.created_at,
          board: { name: post.board_name, slug: post.board_slug },
          voted: Boolean(voted.rowCount),
        },
        comments: comments.rows,
        history: history.rows,
      }
    })
    res.json({ org: { name: org.name, slug: org.slug }, ...data })
  })

  r.post('/public/orgs/:slug/posts/:number/vote', writeLimit, async (req, res) => {
    const org = await findOrg(String(req.params.slug))
    const me = voter(req, res)
    const result = await db.tx({ orgId: org.id }, async (c) => {
      const post = await publicPost(c, Number(req.params.number))
      if (post.merged_into_id) throw new HttpError(409, 'merged', 'This idea was merged into another one.')
      return toggleVote(c, org.id, post.id, me.key, me.name)
    })
    res.json(result)
  })

  r.post('/public/orgs/:slug/posts/:number/comments', writeLimit, async (req, res) => {
    const body = parse(z.object({ body: z.string().trim().min(1).max(2000), name: z.string().trim().max(60).optional() }), req.body)
    const org = await findOrg(String(req.params.slug))
    const comment = await db.tx({ orgId: org.id, userId: req.user?.id }, async (c) => {
      const post = await publicPost(c, Number(req.params.number))
      // Members of this org comment as the team. The org filter matters: the policy
      // also shows a user their own memberships in other orgs.
      const member = req.user
        ? await c.query('SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2', [req.user.id, org.id])
        : null
      return addComment(c, org.id, post.id, {
        authorId: req.user?.id ?? null,
        authorName: req.user?.name ?? (body.name || 'Anonymous'),
        body: body.body,
        isTeam: Boolean(member?.rowCount),
        isInternal: false,
      })
    })
    res.status(201).json({ comment })
  })

  return r
}
