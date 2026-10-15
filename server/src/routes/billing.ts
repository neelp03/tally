import express, { Router } from 'express'
import Stripe from 'stripe'
import { z } from 'zod'
import { unsign } from '../auth.js'
import type { BillingOrg } from '../billing/provider.js'
import { applySubscription, handleStripeEvent } from '../billing/subscriptions.js'
import { orgAccess, tenant, type Deps } from '../context.js'
import { errorHandler, HttpError, parse } from '../http.js'
import { isPaidPlan, PAID_PLANS, PLANS, type PaidPlan } from '../plans.js'
import { usageSummary } from '../usage.js'

async function loadBillingOrg(deps: Deps, req: express.Request): Promise<BillingOrg> {
  return deps.db.tx(tenant(req), async (c) => {
    const { rows } = await c.query<BillingOrg>(
      'SELECT id, name, slug, stripe_customer_id, stripe_subscription_id, subscription_status FROM organizations WHERE id = $1',
      [req.org!.id],
    )
    return rows[0]
  })
}

/** Stripe needs the raw body to verify the signature, so this router is mounted before express.json(). */
export function stripeWebhookRoute(deps: Deps): Router {
  const r = Router()
  r.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (!deps.stripeWebhookSecret) throw new HttpError(404, 'not_found', 'Stripe webhooks are not configured.')
    let event: Stripe.Event
    try {
      event = Stripe.webhooks.constructEvent(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''), deps.stripeWebhookSecret)
    } catch {
      throw new HttpError(400, 'invalid_signature', 'Webhook signature verification failed.')
    }
    const result = await handleStripeEvent(deps.db, event, deps.prices)
    res.json({ received: true, result })
  })
  r.use('/stripe', errorHandler)
  return r
}

export function billingRoutes(deps: Deps): Router {
  const r = Router()
  const appUrl = (slug: string, query = '') => `${deps.publicUrl}/app/${slug}/settings/billing${query}`

  r.get('/orgs/:orgId/billing', orgAccess(deps, 'billing.read'), async (req, res) => {
    const org = await loadBillingOrg(deps, req)
    const details = await deps.db.tx(tenant(req), async (c) => {
      const { rows } = await c.query('SELECT plan, subscription_status, current_period_end FROM organizations WHERE id = $1', [req.org!.id])
      return { ...rows[0], usage: await usageSummary(c, req.org!.id) }
    })
    let invoices: Awaited<ReturnType<typeof deps.billing.invoices>> = []
    try {
      invoices = await deps.billing.invoices(org)
    } catch (err) {
      console.error('Could not list invoices', err)
    }
    res.json({
      mode: deps.billing.mode,
      plan: details.plan,
      status: details.subscription_status,
      currentPeriodEnd: details.current_period_end,
      hasCustomer: Boolean(org.stripe_customer_id),
      usage: details.usage,
      plans: PLANS,
      invoices,
    })
  })

  r.post('/orgs/:orgId/billing/checkout', orgAccess(deps, 'billing.manage'), async (req, res) => {
    const { plan } = parse(z.object({ plan: z.enum(PAID_PLANS) }), req.body)
    const org = await loadBillingOrg(deps, req)
    const url = await deps.billing.checkout(org, plan, req.user!.email, {
      success: appUrl(org.slug, '?checkout=success'),
      cancel: appUrl(org.slug, '?checkout=canceled'),
    })
    res.json({ url })
  })

  r.post('/orgs/:orgId/billing/portal', orgAccess(deps, 'billing.manage'), async (req, res) => {
    const org = await loadBillingOrg(deps, req)
    res.json({ url: await deps.billing.portal(org, appUrl(org.slug)) })
  })

  /** Demo mode only: end the simulated subscription, the way a Stripe cancellation would. */
  r.post('/orgs/:orgId/billing/demo-cancel', orgAccess(deps, 'billing.manage'), async (req, res) => {
    if (deps.billing.mode !== 'demo') throw new HttpError(404, 'not_found', 'Use the Stripe billing portal to cancel.')
    const org = await loadBillingOrg(deps, req)
    await applySubscription(
      deps.db,
      {
        orgId: org.id,
        customerId: null,
        subscriptionId: org.stripe_subscription_id ?? `demo_sub_${org.id}`,
        priceId: null,
        status: 'canceled',
        periodEnd: null,
        eventAt: new Date(),
      },
      deps.prices,
      null,
    )
    res.json({ ok: true })
  })

  // Target of the demo "checkout" link (see DemoBilling). Signed, short-lived, single purpose.
  r.get('/billing/demo-checkout', async (req, res) => {
    if (deps.billing.mode !== 'demo') throw new HttpError(404, 'not_found', 'Not found.')
    const token = unsign<{ orgId: string; plan: PaidPlan; next: string; exp: number }>(String(req.query.token ?? ''), deps.secret)
    if (!token || !isPaidPlan(token.plan)) throw new HttpError(400, 'invalid_token', 'This checkout link expired. Start again from Billing.')
    await applySubscription(
      deps.db,
      {
        orgId: token.orgId,
        customerId: null,
        subscriptionId: `demo_sub_${token.orgId}`,
        priceId: deps.prices[token.plan] ?? null,
        status: 'active',
        periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        eventAt: new Date(),
      },
      deps.prices,
      null,
    )
    if (!token.next.startsWith(deps.publicUrl)) throw new HttpError(400, 'invalid_token', 'Invalid redirect.')
    res.redirect(token.next)
  })

  return r
}

