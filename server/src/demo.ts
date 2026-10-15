import { randomInt, randomUUID } from 'node:crypto'
import { audit } from './audit.js'
import type { Db, Tx } from './db.js'
import { createOrg, type CreatedOrg } from './orgs.js'

const DEMO_DOMAIN = 'demo.tally.dev'
const DAY = 24 * 60 * 60 * 1000

type Status = 'open' | 'under_review' | 'planned' | 'in_progress' | 'shipped' | 'closed'

const POSTS: { board: 'feature' | 'bug' | 'internal'; title: string; body: string; status: Status; votes: number; daysAgo: number; tags: string[]; author: string }[] = [
  { board: 'feature', title: 'Export dashboards to PDF', body: 'Our executive team relies on Northwind dashboards to track quarterly OKRs. Right now someone screenshots each widget for the Friday update deck. An "Export to PDF" button that captures the current state of every chart would save us about two hours a week.', status: 'planned', votes: 142, daysAgo: 41, tags: ['reporting', 'analytics'], author: 'Sarah Jensen' },
  { board: 'feature', title: 'SSO with Okta', body: 'Enterprise requirement for our rollout. We need SAML support so everyone signs in through our identity provider.', status: 'in_progress', votes: 98, daysAgo: 37, tags: ['security', 'enterprise'], author: 'Michael Torres' },
  { board: 'feature', title: 'Dark mode for embedded charts', body: 'Our app is dark-mode only, so the white embedded charts stand out. A theme option for embeds would fix it.', status: 'open', votes: 75, daysAgo: 22, tags: ['ui'], author: 'Alex Wu' },
  { board: 'bug', title: 'Webhook payloads missing customer ID', body: 'When receiving post.created events, the payload has no customer_id field, so we cannot route them in our CRM.', status: 'under_review', votes: 64, daysAgo: 9, tags: ['bug', 'api'], author: 'Dana Torres' },
  { board: 'feature', title: 'Zapier integration', body: 'Please add native Zapier support to route new feedback into Slack and Linear without writing code.', status: 'shipped', votes: 52, daysAgo: 58, tags: ['integrations'], author: 'Lena Morris' },
  { board: 'bug', title: "Can't reset password via email link", body: 'The password reset token expires immediately when opened from Outlook, probably because the link scanner opens it first.', status: 'closed', votes: 41, daysAgo: 33, tags: ['bug'], author: 'Jonah Diaz' },
  { board: 'feature', title: 'Role-based access for dashboards', body: 'We need fine-grained permissions so contractors only see the dashboards for their project.', status: 'in_progress', votes: 29, daysAgo: 27, tags: ['security'], author: 'Riya Kapoor' },
  { board: 'feature', title: 'Custom domain for the public board', body: 'We want to host our public board at feedback.ourcompany.com instead of a shared domain.', status: 'open', votes: 18, daysAgo: 6, tags: ['platform'], author: 'Paul Lee' },
  { board: 'bug', title: 'Typo in billing settings page', body: "The word 'subscription' is spelled 'subcription' under the plan name.", status: 'shipped', votes: 8, daysAgo: 12, tags: ['bug'], author: 'Mia Song' },
  { board: 'feature', title: 'Higher API rate limits', body: 'We hit the 100 requests per minute limit during nightly syncs. A burst allowance would help.', status: 'open', votes: 3, daysAgo: 2, tags: ['api'], author: 'Tom Becker' },
  { board: 'feature', title: 'Scheduled email digests', body: 'A weekly email with new and trending requests for each board would keep our PMs in the loop.', status: 'under_review', votes: 34, daysAgo: 4, tags: ['notifications'], author: 'Grace Kim' },
  { board: 'feature', title: 'Slack notifications for status changes', body: 'Post to a Slack channel when a request moves to Planned or Shipped.', status: 'planned', votes: 47, daysAgo: 15, tags: ['integrations', 'notifications'], author: 'Omar Haddad' },
  { board: 'internal', title: 'Evaluate new charting library', body: 'Spike: compare rendering speed and PDF export support of two charting libraries.', status: 'in_progress', votes: 4, daysAgo: 5, tags: ['engineering'], author: 'Marcus Tran' },
]

const TEAM = [
  { name: 'Marcus Tran', role: 'admin' },
  { name: 'Aisha Wells', role: 'member' },
  { name: 'Raj Kumar', role: 'member' },
] as const

const STATUS_PATH: Record<Status, Status[]> = {
  open: [],
  under_review: ['under_review'],
  planned: ['under_review', 'planned'],
  in_progress: ['under_review', 'planned', 'in_progress'],
  shipped: ['planned', 'in_progress', 'shipped'],
  closed: ['under_review', 'closed'],
}

/** A fresh demo org per visitor: a Pro plan, three boards, a team, posts, votes, comments and history. */
export async function seedDemoOrg(db: Db, ip: string | null): Promise<{ userId: string; org: CreatedOrg }> {
  const tag = randomUUID().slice(0, 8)
  return db.tx({}, async (c) => {
    const user = await insertUser(c, 'Jane Doe', `jane-${tag}@${DEMO_DOMAIN}`)
    const org = await createOrg(c, user, 'Northwind Analytics', { ip, isDemo: true, plan: 'pro' })
    await c.query(
      `UPDATE organizations SET subscription_status = 'active', stripe_subscription_id = $2,
              current_period_end = now() + interval '30 days', subscription_event_at = now()
        WHERE id = $1`,
      [org.id, `demo_sub_${org.id}`],
    )

    const teammates = []
    for (const t of TEAM) {
      const u = await insertUser(c, t.name, `${t.name.split(' ')[0].toLowerCase()}-${tag}@${DEMO_DOMAIN}`)
      await c.query('INSERT INTO memberships (org_id, user_id, role, last_active_at) VALUES ($1, $2, $3, $4)', [
        org.id,
        u.id,
        t.role,
        new Date(Date.now() - randomInt(1, 72) * 3600_000),
      ])
      teammates.push(u)
    }
    await c.query(`INSERT INTO invites (org_id, email, role, invited_by) VALUES ($1, $2, 'member', $3)`, [org.id, `lee-${tag}@${DEMO_DOMAIN}`, user.id])

    const featureBoard = (await c.query(`SELECT id FROM boards WHERE slug = 'feature-requests'`)).rows[0].id
    const bugBoard = (await c.query(`INSERT INTO boards (org_id, name, slug, is_public, created_at) VALUES ($1, 'Bug Reports', 'bug-reports', true, now() + interval '1 second') RETURNING id`, [org.id])).rows[0].id
    const internalBoard = (await c.query(`INSERT INTO boards (org_id, name, slug, is_public, created_at) VALUES ($1, 'Internal Roadmap', 'internal-roadmap', false, now() + interval '2 seconds') RETURNING id`, [org.id])).rows[0].id
    const boardId = { feature: featureBoard, bug: bugBoard, internal: internalBoard }

    let number = 0
    for (const p of POSTS) {
      const created = new Date(Date.now() - p.daysAgo * DAY)
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO posts (org_id, board_id, number, title, body, status, tags, author_name, vote_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
        [org.id, boardId[p.board], ++number, p.title, p.body, p.status, p.tags, p.author, p.votes, created],
      )
      const postId = rows[0].id

      // Votes spread from creation until now, so "votes this week" has real data.
      await c.query(
        `INSERT INTO votes (org_id, post_id, voter_key, voter_name, created_at)
         SELECT $1, $2, 'anon:' || gen_random_uuid(), NULL,
                $3::timestamptz + (random() * (now() - $3::timestamptz))
           FROM generate_series(1, $4)`,
        [org.id, postId, created, p.votes],
      )

      await c.query(`INSERT INTO status_changes (org_id, post_id, to_status, created_at) VALUES ($1, $2, 'open', $3)`, [org.id, postId, created])
      let from: Status = 'open'
      const path = STATUS_PATH[p.status]
      for (let i = 0; i < path.length; i++) {
        const at = new Date(created.getTime() + ((i + 1) / (path.length + 1)) * (Date.now() - created.getTime()))
        await c.query(
          'INSERT INTO status_changes (org_id, post_id, from_status, to_status, changed_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [org.id, postId, from, path[i], user.id, at],
        )
        from = path[i]
      }
    }

    // A conversation on the top request: a customer, an internal note and a team reply.
    const top = (await c.query(`SELECT id FROM posts WHERE number = 1`)).rows[0].id
    const comments: [string, string, boolean, boolean, number][] = [
      ['Sarah Jensen', 'Any update? This is the one thing our leadership team keeps asking about.', false, false, 6],
      ['Marcus Tran', 'Spoke with engineering: the charting library supports static export, so we can bundle this with the print layout work.', true, true, 2],
      ['Jane Doe', "Thanks for the patience, everyone. This is planned for next quarter, and we'll post here when the beta opens.", true, false, 1],
      ['Lena Morris', 'Same need here. We would also want an option to hide filters in the export.', false, false, 1],
    ]
    for (const [name, body, isTeam, isInternal, daysAgo] of comments) {
      await c.query(
        'INSERT INTO comments (org_id, post_id, author_name, body, is_team, is_internal, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [org.id, top, name, body, isTeam, isInternal, new Date(Date.now() - daysAgo * DAY)],
      )
    }
    await c.query(`UPDATE posts SET comment_count = (SELECT count(*) FROM comments WHERE post_id = posts.id AND NOT is_internal)`)
    await c.query(`UPDATE organizations SET posts_this_period = (SELECT count(*) FROM posts WHERE created_at > date_trunc('month', now())) WHERE id = $1`, [org.id])

    const me = { type: 'user' as const, id: user.id, label: user.name }
    const marcus = { type: 'user' as const, id: teammates[0].id, label: teammates[0].name }
    for (const e of [
      { actor: marcus, action: 'board.created', target: 'Internal Roadmap' },
      { actor: me, action: 'member.invited', target: `lee-${tag}@${DEMO_DOMAIN}` },
      { actor: marcus, action: 'post.status_changed', target: 'SSO with Okta', metadata: { from: 'planned', to: 'in_progress' } },
      { actor: me, action: 'post.status_changed', target: 'Export dashboards to PDF', metadata: { from: 'under_review', to: 'planned' } },
    ]) {
      await audit(c, { orgId: org.id, ip, ...e })
    }
    return { userId: user.id, org }
  })
}

async function insertUser(c: Tx, name: string, email: string) {
  const { rows } = await c.query<{ id: string }>('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id', [email, name])
  return { id: rows[0].id, name }
}

/** Delete demo orgs (and their demo-only users) older than maxAgeMs. */
export async function deleteExpiredDemos(db: Db, maxAgeMs = DAY) {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM organizations WHERE is_demo AND created_at < now() - make_interval(secs => $1)`,
    [maxAgeMs / 1000],
  )
  for (const { id } of rows) {
    await db.tx({ orgId: id }, async (c) => {
      const members = await c.query<{ user_id: string }>('SELECT user_id FROM memberships WHERE org_id = $1', [id])
      await c.query('DELETE FROM organizations WHERE id = $1', [id])
      await c.query(`DELETE FROM users WHERE id = ANY($1) AND email LIKE '%@${DEMO_DOMAIN}'`, [members.rows.map((m) => m.user_id)])
    })
  }
  return rows.length
}
