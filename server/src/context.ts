import type { NextFunction, Request, Response } from 'express'
import type { Actor } from './audit.js'
import { sessionUserId } from './auth.js'
import type { BillingProvider } from './billing/provider.js'
import type { PriceIds } from './billing/subscriptions.js'
import type { Db, TenantContext } from './db.js'
import { forbidden, HttpError } from './http.js'
import type { Plan } from './plans.js'
import { can, type Permission, type Role } from './rbac.js'
import type { RateLimiter } from './ratelimit.js'

export interface GoogleConfig {
  clientId: string
  clientSecret: string
  /** Swappable for tests; defaults to global fetch. */
  fetch?: typeof fetch
}

export interface Deps {
  db: Db
  secret: string
  /** Where the browser app lives (used for redirects back from Stripe and Google). */
  publicUrl: string
  secureCookies: boolean
  billing: BillingProvider
  prices: PriceIds
  stripeWebhookSecret?: string
  google?: GoogleConfig
  platformAdminEmails: Set<string>
  demo: boolean
  limiter: RateLimiter
  accountsPerMinute: number
}

export interface SessionUser {
  id: string
  email: string
  name: string
  is_platform_admin: boolean
}

export interface OrgAccess {
  id: string
  slug: string
  name: string
  plan: Plan
  role: Role
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
    org?: OrgAccess
  }
}

/** Attach the signed-in user, if any. Never fails: public pages work without a session. */
export function loadUser(deps: Deps) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const userId = sessionUserId(req, deps.secret)
    if (userId) {
      const { rows } = await deps.db.pool.query<SessionUser>(
        'SELECT id, email, name, is_platform_admin FROM users WHERE id = $1',
        [userId],
      )
      req.user = rows[0]
    }
    next()
  }
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.')
  next()
}

/**
 * Browsers attach cookies to cross-site requests, so state-changing calls must
 * carry a header a cross-site form can't set. Without CORS enabled, another
 * site can't add it to a fetch either.
 */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'tally') {
    throw new HttpError(403, 'csrf', 'Missing X-Requested-With header.')
  }
  next()
}

/**
 * Resolve :orgId to the caller's membership. A non-member gets 404, so org ids
 * can't be probed. Every later query for this request runs inside this org.
 */
export function orgAccess(deps: Deps, permission: Permission = 'posts.read') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user!
    const orgId = String(req.params.orgId)
    if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new HttpError(404, 'not_found', 'Organization not found.')
    const row = await deps.db.tx({ userId: user.id }, async (c) => {
      const { rows } = await c.query<OrgAccess>(
        `SELECT o.id, o.slug, o.name, o.plan, m.role
           FROM memberships m JOIN organizations o ON o.id = m.org_id
          WHERE m.org_id = $1 AND m.user_id = $2`,
        [orgId, user.id],
      )
      return rows[0]
    })
    if (!row) throw new HttpError(404, 'not_found', 'Organization not found.')
    if (!can(row.role, permission)) throw forbidden(`Your role (${row.role}) can't do that.`)
    req.org = row
    next()
  }
}

export function tenant(req: Request): TenantContext {
  return { orgId: req.org!.id, userId: req.user!.id, userEmail: req.user!.email }
}

export function actor(req: Request): Actor {
  return { type: 'user', id: req.user!.id, label: req.user!.name }
}

export function requirePermission(req: Request, permission: Permission) {
  if (!can(req.org!.role, permission)) throw forbidden(`Your role (${req.org!.role}) can't do that.`)
}
