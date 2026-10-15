import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { Router } from 'express'
import { DemoBilling, StripeBilling } from './billing/provider.js'
import type { PriceIds } from './billing/subscriptions.js'
import { loadUser, requireCsrfHeader, requireUser, type Deps, type GoogleConfig } from './context.js'
import { connect, migrate, type Db } from './db.js'
import { deleteExpiredDemos } from './demo.js'
import { errorHandler, HttpError } from './http.js'
import { RateLimiter } from './ratelimit.js'
import { adminRoutes } from './routes/admin.js'
import { apiV1Routes } from './routes/api-v1.js'
import { authRoutes } from './routes/auth.js'
import { billingRoutes, stripeWebhookRoute } from './routes/billing.js'
import { memberRoutes } from './routes/members.js'
import { orgRoutes } from './routes/org.js'
import { postRoutes } from './routes/posts.js'
import { publicRoutes } from './routes/public.js'

export interface TallyOptions {
  /** Owner role: runs migrations. */
  ownerUrl: string
  /** App role: serves requests. Must not be a superuser or have BYPASSRLS. */
  appUrl: string
  secret: string
  publicUrl: string
  port?: number
  staticDir?: string
  stripe?: { secretKey: string; webhookSecret?: string; prices: PriceIds }
  /** Webhook secret without a Stripe API key (tests verify signatures without network calls). */
  stripeWebhookSecret?: string
  google?: GoogleConfig
  platformAdminEmails?: string[]
  demo?: boolean
  trustProxy?: number
  accountsPerMinute?: number
}

export interface Tally {
  server: Server
  db: Db
  port: number
  url: string
  close(): Promise<void>
}

const DEMO_PRICES: PriceIds = { pro: 'demo_price_pro', business: 'demo_price_business' }

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
  'font-src https://fonts.gstatic.com https://cdn.fontshare.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self' https://checkout.stripe.com https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

export async function startTally(opts: TallyOptions): Promise<Tally> {
  await migrate(opts.ownerUrl, opts.appUrl)
  const db = connect(opts.appUrl)
  await db.assertRlsEnforced()

  const prices = opts.stripe?.prices ?? DEMO_PRICES
  const deps: Deps = {
    db,
    secret: opts.secret,
    publicUrl: opts.publicUrl.replace(/\/$/, ''),
    secureCookies: opts.publicUrl.startsWith('https://'),
    billing: opts.stripe ? new StripeBilling(opts.stripe.secretKey, prices, db) : new DemoBilling(opts.secret, opts.publicUrl.replace(/\/$/, '')),
    prices,
    stripeWebhookSecret: opts.stripe?.webhookSecret ?? opts.stripeWebhookSecret,
    google: opts.google,
    platformAdminEmails: new Set((opts.platformAdminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    demo: opts.demo ?? false,
    limiter: new RateLimiter(),
    accountsPerMinute: opts.accountsPerMinute ?? 10,
  }

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', opts.trustProxy ?? 0)
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    next()
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  // Stripe signs the raw bytes, so this must run before any JSON parsing.
  app.use('/api', stripeWebhookRoute(deps))

  // Public REST API: API-key auth, no cookies, so no CSRF check.
  const v1 = Router()
  v1.use(express.json({ limit: '100kb' }))
  v1.use(apiV1Routes(deps))
  v1.use(errorHandler)
  app.use('/api/v1', v1)

  // Browser API: cookie sessions.
  const api = Router()
  api.use(express.json({ limit: '100kb' }))
  api.use(loadUser(deps))
  api.use(requireCsrfHeader)
  api.use(authRoutes(deps))
  api.use(publicRoutes(deps))
  api.use(requireUser)
  api.use(orgRoutes(deps))
  api.use(postRoutes(deps))
  api.use(memberRoutes(deps))
  api.use(billingRoutes(deps))
  api.use(adminRoutes(deps))
  api.use(() => {
    throw new HttpError(404, 'not_found', 'Not found.')
  })
  api.use(errorHandler)
  app.use('/api', api)

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const dir = opts.staticDir
    app.use('/assets', express.static(`${dir}/assets`, { immutable: true, maxAge: '1y', fallthrough: false }))
    app.use(express.static(dir, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }))
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile('index.html', { root: dir })
    })
  }

  let cleanup: NodeJS.Timeout | undefined
  if (deps.demo) {
    const run = () => deleteExpiredDemos(db).catch((err) => console.error('Demo cleanup failed', err))
    await run()
    cleanup = setInterval(run, 60 * 60 * 1000)
    cleanup.unref()
  }

  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve))
  const port = (server.address() as AddressInfo).port

  return {
    server,
    db,
    port,
    url: `http://localhost:${port}`,
    async close() {
      clearInterval(cleanup)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      await db.close()
    },
  }
}
