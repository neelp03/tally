import type { Tx } from './db.js'
import { HttpError } from './http.js'
import { PLANS, type Plan } from './plans.js'

type Counter = 'posts' | 'api_calls'
const COLUMN: Record<Counter, string> = { posts: 'posts_this_period', api_calls: 'api_calls_this_period' }

export class UsageLimitError extends HttpError {
  constructor(resource: string, limit: number | null, plan: Plan) {
    super(402, 'usage_limit', `Your ${PLANS[plan].name} plan allows ${limit ?? 0} ${resource}. Upgrade to add more.`, {
      resource,
      limit,
      plan,
    })
  }
}

/**
 * Take one unit from a monthly counter, atomically. The UPDATE both resets the
 * counter when a new month started and refuses to go past the limit, so two
 * concurrent requests can never both take the last unit.
 */
export async function consume(c: Tx, orgId: string, counter: Counter, limit: number): Promise<boolean> {
  const col = COLUMN[counter]
  // Start a new period if the month rolled over.
  await c.query(
    `UPDATE organizations
        SET posts_this_period = 0, api_calls_this_period = 0, usage_period_start = date_trunc('month', now())::date
      WHERE id = $1 AND usage_period_start < date_trunc('month', now())::date`,
    [orgId],
  )
  const { rowCount } = await c.query(`UPDATE organizations SET ${col} = ${col} + 1 WHERE id = $1 AND ${col} < $2`, [orgId, limit])
  return rowCount === 1
}

/** Lock the org row so seat and board counts can be checked and changed without races. */
export async function lockOrg(c: Tx, orgId: string): Promise<{ plan: Plan }> {
  const { rows } = await c.query<{ plan: Plan }>('SELECT plan FROM organizations WHERE id = $1 FOR UPDATE', [orgId])
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Organization not found.')
  return rows[0]
}

export async function seatsUsed(c: Tx, orgId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM memberships WHERE org_id = $1) + (SELECT count(*) FROM invites WHERE org_id = $1) AS n`,
    [orgId],
  )
  return Number(rows[0].n)
}

export async function assertSeatAvailable(c: Tx, orgId: string) {
  const { plan } = await lockOrg(c, orgId)
  const limit = PLANS[plan].seats
  if ((await seatsUsed(c, orgId)) >= limit) throw new UsageLimitError('seats', limit, plan)
}

export async function assertBoardAvailable(c: Tx, orgId: string) {
  const { plan } = await lockOrg(c, orgId)
  const limit = PLANS[plan].boards
  if (limit === null) return
  const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM boards WHERE org_id = $1', [orgId])
  if (Number(rows[0].n) >= limit) throw new UsageLimitError('boards', limit, plan)
}

export async function consumePost(c: Tx, orgId: string) {
  const { plan } = await lockOrg(c, orgId)
  const limit = PLANS[plan].postsPerMonth
  if (!(await consume(c, orgId, 'posts', limit))) throw new UsageLimitError('posts per month', limit, plan)
}

export interface UsageSummary {
  posts: { used: number; limit: number }
  boards: { used: number; limit: number | null }
  seats: { used: number; limit: number }
  apiCalls: { used: number; limit: number }
  periodStart: string
}

export async function usageSummary(c: Tx, orgId: string): Promise<UsageSummary> {
  const { rows } = await c.query(
    `SELECT o.plan,
            CASE WHEN o.usage_period_start < date_trunc('month', now())::date THEN 0 ELSE o.posts_this_period END AS posts,
            CASE WHEN o.usage_period_start < date_trunc('month', now())::date THEN 0 ELSE o.api_calls_this_period END AS api_calls,
            date_trunc('month', now())::date AS period_start,
            (SELECT count(*) FROM boards WHERE org_id = o.id) AS boards
       FROM organizations o WHERE o.id = $1`,
    [orgId],
  )
  const row = rows[0]
  const limits = PLANS[row.plan as Plan]
  return {
    posts: { used: row.posts, limit: limits.postsPerMonth },
    boards: { used: Number(row.boards), limit: limits.boards },
    seats: { used: await seatsUsed(c, orgId), limit: limits.seats },
    apiCalls: { used: row.api_calls, limit: limits.apiCallsPerMonth },
    periodStart: row.period_start.toISOString().slice(0, 10),
  }
}
