import { randomInt } from 'node:crypto'
import { audit, type Actor } from './audit.js'
import type { Tx } from './db.js'
import { PLANS, type Plan } from './plans.js'
import { seatsUsed } from './usage.js'

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org'
  )
}

/** Org slugs are global (they appear in public board URLs). */
export async function uniqueOrgSlug(c: Tx, name: string): Promise<string> {
  const base = slugify(name)
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomInt(1000, 10000)}`
    const { rowCount } = await c.query('SELECT 1 FROM organizations WHERE slug = $1', [slug])
    if (rowCount === 0) return slug
  }
  throw new Error('Could not find a free organization slug.')
}

/** Switch the current transaction into an org, e.g. right after creating it. */
export async function enterOrg(c: Tx, orgId: string) {
  await c.query(`SELECT set_config('app.org_id', $1, true)`, [orgId])
}

export interface CreatedOrg {
  id: string
  slug: string
  name: string
}

/** Create an org with the user as owner and one public board. Runs in the caller's transaction. */
export async function createOrg(
  c: Tx,
  owner: { id: string; name: string },
  name: string,
  opts: { ip?: string | null; isDemo?: boolean; plan?: Plan } = {},
): Promise<CreatedOrg> {
  const slug = await uniqueOrgSlug(c, name)
  const { rows } = await c.query<CreatedOrg>(
    'INSERT INTO organizations (name, slug, is_demo, plan) VALUES ($1, $2, $3, $4) RETURNING id, slug, name',
    [name, slug, opts.isDemo ?? false, opts.plan ?? 'free'],
  )
  const org = rows[0]
  await enterOrg(c, org.id)
  await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [org.id, owner.id])
  await c.query(`INSERT INTO boards (org_id, name, slug, is_public) VALUES ($1, 'Feature Requests', 'feature-requests', true)`, [org.id])
  const actor: Actor = { type: 'user', id: owner.id, label: owner.name }
  await audit(c, { orgId: org.id, actor, action: 'organization.created', target: name, ip: opts.ip })
  return org
}

/**
 * Domain capture for SSO: a Business org can claim an email domain, and anyone
 * who signs in with Google using a verified address on that domain joins it as
 * a member (if a seat is free). Runs once per sign-in.
 */
export async function joinOrgsByDomain(
  run: <T>(ctx: { orgId?: string; userId: string }, fn: (c: Tx) => Promise<T>) => Promise<T>,
  user: { id: string; name: string; email: string },
): Promise<string[]> {
  const domain = user.email.split('@')[1]?.toLowerCase()
  if (!domain) return []
  const candidates = await run({ userId: user.id }, async (c) => {
    const { rows } = await c.query<{ id: string; plan: Plan }>(
      `SELECT o.id, o.plan FROM organizations o
        WHERE o.sso_domain = $1
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id = $2)`,
      [domain, user.id],
    )
    return rows.filter((r) => PLANS[r.plan].ssoDomain)
  })

  const joined: string[] = []
  for (const org of candidates) {
    const ok = await run({ orgId: org.id, userId: user.id }, async (c) => {
      await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [org.id])
      if ((await seatsUsed(c, org.id)) >= PLANS[org.plan].seats) return false
      await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [org.id, user.id])
      await audit(c, {
        orgId: org.id,
        actor: { type: 'system', label: 'SSO' },
        action: 'member.joined_by_domain',
        target: user.email,
      })
      return true
    })
    if (ok) joined.push(org.id)
  }
  return joined
}
