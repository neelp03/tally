import type Stripe from 'stripe'
import { audit } from '../audit.js'
import type { Db } from '../db.js'
import { PLANS, type Plan } from '../plans.js'

/** The subscription facts we store, from a real Stripe event or the demo checkout. */
export interface SubscriptionState {
  orgId?: string | null
  customerId: string | null
  subscriptionId: string
  priceId: string | null
  status: string
  periodEnd: Date | null
  /** When the source event was created; used to ignore out-of-order deliveries. */
  eventAt: Date
}

export interface PriceIds {
  pro?: string
  business?: string
}

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])

export function planForPrice(priceId: string | null, prices: PriceIds): Plan | null {
  if (priceId && priceId === prices.pro) return 'pro'
  if (priceId && priceId === prices.business) return 'business'
  return null
}

async function findOrgId(db: Db, s: Pick<SubscriptionState, 'orgId' | 'customerId'>): Promise<string | null> {
  // organizations is readable without a tenant context (policy org_read), so the
  // org can be resolved before we switch into its context to change it.
  const { rows } = await db.pool.query<{ id: string }>(
    'SELECT id FROM organizations WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($2::text IS NOT NULL AND stripe_customer_id = $2) LIMIT 1',
    [s.orgId ?? null, s.customerId],
  )
  return rows[0]?.id ?? null
}

/**
 * Store a subscription's state on its org and derive the plan from it. A canceled
 * or unpaid subscription drops the org to Free; data is kept, new usage is limited.
 * Returns false if the event was older than the last one applied.
 */
export async function applySubscription(
  db: Db,
  s: SubscriptionState,
  prices: PriceIds,
  eventId: string | null,
): Promise<'applied' | 'stale' | 'duplicate' | 'unknown_org'> {
  const orgId = await findOrgId(db, s)
  if (!orgId) {
    if (eventId) await recordEvent(db, eventId, 'unmatched')
    return 'unknown_org'
  }

  return db.tx({ orgId }, async (c) => {
    if (eventId) {
      const { rowCount } = await c.query('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        eventId,
        'subscription',
      ])
      if (rowCount === 0) return 'duplicate'
    }

    const { rows } = await c.query<{ plan: Plan; subscription_event_at: Date | null }>(
      'SELECT plan, subscription_event_at FROM organizations WHERE id = $1 FOR UPDATE',
      [orgId],
    )
    const current = rows[0]
    if (current.subscription_event_at && current.subscription_event_at > s.eventAt) return 'stale'

    const live = LIVE_STATUSES.has(s.status)
    const plan: Plan = live ? (planForPrice(s.priceId, prices) ?? current.plan) : 'free'
    await c.query(
      `UPDATE organizations
          SET plan = $2, stripe_subscription_id = $3, subscription_status = $4, current_period_end = $5,
              subscription_event_at = $6, stripe_customer_id = COALESCE($7, stripe_customer_id)
        WHERE id = $1`,
      [orgId, plan, live ? s.subscriptionId : null, s.status, s.periodEnd, s.eventAt, s.customerId],
    )
    if (plan !== current.plan) {
      await audit(c, {
        orgId,
        actor: { type: 'system', label: 'Stripe' },
        action: 'subscription.updated',
        target: `${PLANS[current.plan].name} → ${PLANS[plan].name}`,
        metadata: { status: s.status, subscriptionId: s.subscriptionId },
      })
    }
    return 'applied'
  })
}

async function recordEvent(db: Db, id: string, type: string) {
  await db.pool.query('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, type])
}

function subscriptionState(sub: Stripe.Subscription, eventAt: Date): SubscriptionState {
  const item = sub.items.data[0]
  // Newer Stripe API versions keep the period on the item; older ones on the subscription.
  const periodEnd = (item as { current_period_end?: number } | undefined)?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end
  return {
    orgId: sub.metadata?.orgId ?? null,
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null),
    subscriptionId: sub.id,
    priceId: item?.price?.id ?? null,
    status: sub.status,
    periodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    eventAt,
  }
}

/** Route a verified Stripe event. Unknown event types are acknowledged and ignored. */
export async function handleStripeEvent(db: Db, event: Stripe.Event, prices: PriceIds): Promise<string> {
  const eventAt = new Date(event.created * 1000)
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return applySubscription(db, subscriptionState(event.data.object, eventAt), prices, event.id)

    case 'invoice.payment_failed': {
      const invoice = event.data.object
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null)
      const orgId = await findOrgId(db, { customerId })
      if (!orgId) return 'unknown_org'
      return db.tx({ orgId }, async (c) => {
        const { rowCount } = await c.query('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [event.id, event.type])
        if (rowCount === 0) return 'duplicate'
        await audit(c, {
          orgId,
          actor: { type: 'system', label: 'Stripe' },
          action: 'invoice.payment_failed',
          target: invoice.number ?? invoice.id,
        })
        return 'applied'
      })
    }

    default:
      return 'ignored'
  }
}
