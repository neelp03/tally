import type { Tx } from './db.js'
import { notFound } from './http.js'
import { consumePost } from './usage.js'

export const STATUSES = ['open', 'under_review', 'planned', 'in_progress', 'shipped', 'closed'] as const
export type Status = (typeof STATUSES)[number]

export const POST_COLUMNS = `p.id, p.number, p.title, p.body, p.status, p.tags, p.vote_count, p.comment_count,
  p.author_name, p.created_at, p.updated_at, p.merged_into_id, b.id AS board_id, b.name AS board_name, b.slug AS board_slug`

export interface NewPost {
  boardId: string
  title: string
  body: string
  authorId: string | null
  authorName: string
}

/** Create a post, counting it against the monthly limit. Runs in the org's transaction. */
export async function createPost(c: Tx, orgId: string, p: NewPost) {
  // RLS hides other tenants' boards, so this also rejects a foreign board id.
  const board = await c.query('SELECT 1 FROM boards WHERE id = $1', [p.boardId])
  if (!board.rowCount) throw notFound('Board not found.')
  await consumePost(c, orgId) // also locks the org row, which makes number allocation race-free
  const { rows } = await c.query(
    `INSERT INTO posts (org_id, board_id, number, title, body, author_id, author_name)
     VALUES ($1, $2, (SELECT COALESCE(max(number), 0) + 1 FROM posts WHERE org_id = $1), $3, $4, $5, $6)
     RETURNING id, number`,
    [orgId, p.boardId, p.title, p.body, p.authorId, p.authorName],
  )
  await c.query(`INSERT INTO status_changes (org_id, post_id, to_status, changed_by) VALUES ($1, $2, 'open', $3)`, [
    orgId,
    rows[0].id,
    p.authorId,
  ])
  return rows[0] as { id: string; number: number }
}

export async function getPost(c: Tx, where: { id?: string; number?: number }) {
  const { rows } = await c.query(
    `SELECT ${POST_COLUMNS} FROM posts p JOIN boards b ON b.id = p.board_id
      WHERE ${where.id ? 'p.id = $1' : 'p.number = $1'}`,
    [where.id ?? where.number],
  )
  if (!rows[0]) throw notFound('Post not found.')
  return rows[0]
}

export async function setStatus(c: Tx, orgId: string, postId: string, to: Status, changedBy: string | null) {
  const { rows } = await c.query<{ status: Status }>('SELECT status FROM posts WHERE id = $1 FOR UPDATE', [postId])
  const from = rows[0]?.status
  if (!from) throw notFound('Post not found.')
  if (from === to) return { from, to, changed: false }
  await c.query('UPDATE posts SET status = $2, updated_at = now() WHERE id = $1', [postId, to])
  await c.query('INSERT INTO status_changes (org_id, post_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4, $5)', [
    orgId,
    postId,
    from,
    to,
    changedBy,
  ])
  return { from, to, changed: true }
}

/** Toggle a vote. Returns the new count and whether the voter now has a vote on the post. */
export async function toggleVote(c: Tx, orgId: string, postId: string, voterKey: string, voterName: string | null) {
  const removed = await c.query('DELETE FROM votes WHERE post_id = $1 AND voter_key = $2', [postId, voterKey])
  if (removed.rowCount === 0) {
    await c.query('INSERT INTO votes (org_id, post_id, voter_key, voter_name) VALUES ($1, $2, $3, $4)', [orgId, postId, voterKey, voterName])
  }
  const { rows } = await c.query<{ vote_count: number }>(
    'UPDATE posts SET vote_count = (SELECT count(*) FROM votes WHERE post_id = $1) WHERE id = $1 RETURNING vote_count',
    [postId],
  )
  return { voteCount: rows[0].vote_count, voted: removed.rowCount === 0 }
}

/**
 * Merge a duplicate into a target: votes move over (one per voter), comments
 * move over, and the duplicate is closed with a pointer to the target.
 */
export async function mergePost(c: Tx, orgId: string, fromId: string, intoId: string, userId: string) {
  await c.query(
    `INSERT INTO votes (org_id, post_id, voter_key, voter_name, created_at)
     SELECT org_id, $2, voter_key, voter_name, created_at FROM votes WHERE post_id = $1
     ON CONFLICT (post_id, voter_key) DO NOTHING`,
    [fromId, intoId],
  )
  await c.query('DELETE FROM votes WHERE post_id = $1', [fromId])
  await c.query('UPDATE comments SET post_id = $2 WHERE post_id = $1', [fromId, intoId])
  for (const id of [fromId, intoId]) {
    await c.query(
      `UPDATE posts SET vote_count = (SELECT count(*) FROM votes WHERE post_id = $1),
                        comment_count = (SELECT count(*) FROM comments WHERE post_id = $1 AND NOT is_internal),
                        updated_at = now()
        WHERE id = $1`,
      [id],
    )
  }
  await c.query('UPDATE posts SET merged_into_id = $2 WHERE id = $1', [fromId, intoId])
  await setStatus(c, orgId, fromId, 'closed', userId)
}

export async function addComment(
  c: Tx,
  orgId: string,
  postId: string,
  comment: { authorId: string | null; authorName: string; body: string; isTeam: boolean; isInternal: boolean },
) {
  const { rows } = await c.query(
    `INSERT INTO comments (org_id, post_id, author_id, author_name, body, is_team, is_internal)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, author_name, body, is_team, is_internal, created_at`,
    [orgId, postId, comment.authorId, comment.authorName, comment.body, comment.isTeam, comment.isInternal],
  )
  if (!comment.isInternal) await c.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [postId])
  return rows[0]
}
