import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTally } from './app.js'

const env = process.env
const required = (name: string) => {
  const value = env[name]
  if (!value) {
    console.error(`${name} is not set. See the README section "Configuration".`)
    process.exit(1)
  }
  return value
}

const ownerUrl = required('DATABASE_URL')
const port = Number(env.PORT ?? 3002)
const publicUrl = env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`
const secret = env.SESSION_SECRET ?? (env.NODE_ENV === 'production' ? required('SESSION_SECRET') : 'dev-secret-change-me')

const stripe =
  env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_PRO && env.STRIPE_PRICE_BUSINESS
    ? {
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        prices: { pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS },
      }
    : undefined

const google =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined

// src/index.ts is server/src; the build puts it in server/dist/src.
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, here.includes('/dist/') ? '../../..' : '../..')

const tally = await startTally({
  ownerUrl,
  appUrl: env.APP_DATABASE_URL ?? ownerUrl,
  secret,
  publicUrl,
  port,
  staticDir: resolve(repoRoot, 'client/dist'),
  stripe,
  google,
  platformAdminEmails: (env.PLATFORM_ADMIN_EMAILS ?? '').split(','),
  demo: env.DEMO_MODE === 'true',
  trustProxy: Number(env.TRUST_PROXY ?? 0),
})

console.log(`Tally listening on ${tally.url} (public URL ${publicUrl})`)
console.log(`Billing: ${stripe ? 'Stripe' : 'demo (no Stripe keys)'}. Google sign-in: ${google ? 'on' : 'off'}. Demo mode: ${env.DEMO_MODE === 'true' ? 'on' : 'off'}.`)

const shutdown = async () => {
  await tally.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
