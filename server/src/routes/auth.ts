import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../audit.js'
import { hashPassword, randomToken, SESSION_COOKIE, setCookie, sign, startSession, unsign, verifyPassword, parseCookies } from '../auth.js'
import { requireUser, type Deps } from '../context.js'
import { clientIp, HttpError, parse } from '../http.js'
import { createOrg, joinOrgsByDomain } from '../orgs.js'
import { ipLimit } from '../ratelimit.js'
import { seedDemoOrg } from '../demo.js'

const email = z.string().trim().toLowerCase().email().max(200)
const password = z.string().min(8, 'must be at least 8 characters').max(200)
const STATE_COOKIE = 'tally_oauth_state'

export function authRoutes(deps: Deps): Router {
  const r = Router()
  const { db } = deps
  const accountLimit = ipLimit(deps.limiter, 'accounts', deps.accountsPerMinute)
  const loginLimit = ipLimit(deps.limiter, 'login', deps.accountsPerMinute * 2)

  r.get('/config', (_req, res) => {
    res.json({ googleEnabled: Boolean(deps.google), demo: deps.demo, billingMode: deps.billing.mode })
  })

  r.post('/auth/register', accountLimit, async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        email,
        password,
        orgName: z.string().trim().min(1).max(80).optional(),
      }),
      req.body,
    )
    const passwordHash = await hashPassword(body.password)
    const result = await db.tx({}, async (c) => {
      const existing = await c.query('SELECT 1 FROM users WHERE email = $1', [body.email])
      if (existing.rowCount) throw new HttpError(409, 'email_taken', 'An account with that email already exists. Sign in instead.')
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ($1, $2, $3, $4) RETURNING id',
        [body.email, body.name, passwordHash, deps.platformAdminEmails.has(body.email)],
      )
      const user = { id: rows[0].id, name: body.name }
      const org = body.orgName ? await createOrg(c, user, body.orgName, { ip: clientIp(req) }) : null
      return { userId: user.id, org }
    })
    startSession(res, result.userId, deps.secret, deps.secureCookies)
    res.status(201).json({ org: result.org })
  })

  r.post('/auth/login', loginLimit, async (req, res) => {
    const body = parse(z.object({ email, password: z.string().max(200) }), req.body)
    const { rows } = await db.pool.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE email = $1',
      [body.email],
    )
    if (!(await verifyPassword(body.password, rows[0]?.password_hash ?? null)) || !rows[0]) {
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.')
    }
    startSession(res, rows[0].id, deps.secret, deps.secureCookies)
    res.json({ ok: true })
  })

  r.post('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    res.json({ ok: true })
  })

  /** The signed-in user, their organizations and any invites waiting for their email. */
  r.get('/me', requireUser, async (req, res) => {
    const user = req.user!
    const data = await db.tx({ userId: user.id, userEmail: user.email }, async (c) => {
      const orgs = await c.query(
        `SELECT o.id, o.name, o.slug, o.plan, m.role
           FROM memberships m JOIN organizations o ON o.id = m.org_id
          WHERE m.user_id = $1 ORDER BY o.name`,
        [user.id],
      )
      const invites = await c.query(
        `SELECT i.id, i.role, o.name AS org_name, i.created_at
           FROM invites i JOIN organizations o ON o.id = i.org_id
          WHERE i.email = $1 ORDER BY i.created_at DESC`,
        [user.email],
      )
      return { orgs: orgs.rows, invites: invites.rows }
    })
    res.json({ user, ...data })
  })

  r.post('/invites/:id/accept', requireUser, async (req, res) => {
    const user = req.user!
    const inviteId = String(req.params.id)
    // Read the invite as the invited person (policy invite_read matches the email),
    // then act inside the inviting org.
    const invite = await db.tx({ userId: user.id, userEmail: user.email }, async (c) => {
      const { rows } = await c.query<{ id: string; org_id: string; role: 'admin' | 'member' }>(
        'SELECT id, org_id, role FROM invites WHERE id = $1 AND email = $2',
        [inviteId, user.email],
      )
      return rows[0]
    })
    if (!invite) throw new HttpError(404, 'not_found', 'Invite not found.')
    const org = await db.tx({ orgId: invite.org_id, userId: user.id, userEmail: user.email }, async (c) => {
      // The invite already holds a seat, so swapping it for a membership needs no seat check.
      await c.query('DELETE FROM invites WHERE id = $1', [invite.id])
      await c.query('INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
        invite.org_id,
        user.id,
        invite.role,
      ])
      await audit(c, {
        orgId: invite.org_id,
        actor: { type: 'user', id: user.id, label: user.name },
        action: 'member.joined',
        target: user.email,
        ip: clientIp(req),
        metadata: { role: invite.role },
      })
      const { rows } = await c.query('SELECT id, slug, name FROM organizations WHERE id = $1', [invite.org_id])
      return rows[0]
    })
    res.json({ org })
  })

  // Google sign-in (OpenID Connect authorization code flow).

  r.get('/auth/google', (req, res) => {
    if (!deps.google) throw new HttpError(404, 'not_found', 'Google sign-in is not configured.')
    const state = randomToken()
    setCookie(res, STATE_COOKIE, sign({ state, exp: Date.now() + 10 * 60_000 }, deps.secret), {
      maxAgeMs: 10 * 60_000,
      secure: deps.secureCookies,
    })
    const params = new URLSearchParams({
      client_id: deps.google.clientId,
      redirect_uri: `${deps.publicUrl}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    })
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  })

  r.get('/auth/google/callback', async (req, res) => {
    const google = deps.google
    if (!google) throw new HttpError(404, 'not_found', 'Google sign-in is not configured.')
    const saved = unsign<{ state: string; exp: number }>(parseCookies(req)[STATE_COOKIE], deps.secret)
    res.clearCookie(STATE_COOKIE, { path: '/' })
    if (!saved || saved.state !== req.query.state || typeof req.query.code !== 'string') {
      return res.redirect(`${deps.publicUrl}/signin?error=google_state`)
    }

    // The ID token comes straight from Google's token endpoint over TLS, so its
    // claims can be trusted without verifying the signature (OIDC Core 3.1.3.7).
    const tokenRes = await (google.fetch ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: `${deps.publicUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })
    const token = (await tokenRes.json().catch(() => ({}))) as { id_token?: string }
    const claims = token.id_token ? decodeJwtPayload(token.id_token) : null
    if (
      !tokenRes.ok ||
      !claims ||
      claims.aud !== google.clientId ||
      !['https://accounts.google.com', 'accounts.google.com'].includes(String(claims.iss)) ||
      Number(claims.exp) * 1000 < Date.now() ||
      claims.email_verified !== true ||
      typeof claims.email !== 'string' ||
      typeof claims.sub !== 'string'
    ) {
      return res.redirect(`${deps.publicUrl}/signin?error=google_token`)
    }

    const userEmail = claims.email.toLowerCase()
    const user = await db.tx({}, async (c) => {
      const found = await c.query<{ id: string; name: string; google_sub: string | null }>(
        'SELECT id, name, google_sub FROM users WHERE google_sub = $1 OR email = $2 ORDER BY (google_sub = $1) DESC LIMIT 1',
        [claims.sub, userEmail],
      )
      if (found.rows[0]) {
        if (!found.rows[0].google_sub) await c.query('UPDATE users SET google_sub = $2 WHERE id = $1', [found.rows[0].id, claims.sub])
        return { id: found.rows[0].id, name: found.rows[0].name, email: userEmail }
      }
      const name = typeof claims.name === 'string' && claims.name ? claims.name : userEmail.split('@')[0]
      const { rows } = await c.query<{ id: string }>(
        'INSERT INTO users (email, name, google_sub, is_platform_admin) VALUES ($1, $2, $3, $4) RETURNING id',
        [userEmail, name, claims.sub, deps.platformAdminEmails.has(userEmail)],
      )
      return { id: rows[0].id, name, email: userEmail }
    })
    await joinOrgsByDomain((ctx, fn) => db.tx(ctx, fn), user)
    startSession(res, user.id, deps.secret, deps.secureCookies)
    res.redirect(`${deps.publicUrl}/app`)
  })

  // Demo: every visitor gets a private, pre-filled org, which shows tenant isolation in practice.

  r.post('/demo', accountLimit, async (req, res) => {
    if (!deps.demo) throw new HttpError(404, 'not_found', 'Demo mode is turned off on this server.')
    const { userId, org } = await seedDemoOrg(db, clientIp(req))
    startSession(res, userId, deps.secret, deps.secureCookies)
    res.status(201).json({ org })
  })

  return r
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
  } catch {
    return null
  }
}
