import Stripe from 'stripe'
import { sign } from '../auth.js'
import type { Db } from '../db.js'
import { HttpError } from '../http.js'
import type { PaidPlan } from '../plans.js'
import type { PriceIds } from './subscriptions.js'

export interface BillingOrg {
  id: string
  name: string
  slug: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  subscription_status: string | null
}

export interface Invoice {
  id: string
  number: string | null
  date: string
  amount: number
  currency: string
  status: string | null
  pdfUrl: string | null
}

export interface BillingProvider {
  /** 'stripe' charges real (or test-mode) cards; 'demo' simulates checkout without Stripe. */
  mode: 'stripe' | 'demo'
  /** Returns a URL to send the browser to, or null if the plan changed in place. */
  checkout(org: BillingOrg, plan: PaidPlan, email: string, urls: { success: string; cancel: string }): Promise<string | null>
  portal(org: BillingOrg, returnUrl: string): Promise<string>
  invoices(org: BillingOrg): Promise<Invoice[]>
}

export class StripeBilling implements BillingProvider {
  readonly mode = 'stripe' as const
  readonly stripe: Stripe

  constructor(
    secretKey: string,
    private prices: PriceIds,
    private db: Db,
  ) {
    this.stripe = new Stripe(secretKey)
  }

  private priceFor(plan: PaidPlan): string {
    const price = this.prices[plan]
    if (!price) throw new HttpError(500, 'billing_misconfigured', `No Stripe price is configured for the ${plan} plan.`)
    return price
  }

  private async customerFor(org: BillingOrg, email: string): Promise<string> {
    if (org.stripe_customer_id) return org.stripe_customer_id
    const customer = await this.stripe.customers.create({ name: org.name, email, metadata: { orgId: org.id } })
    // Saved before checkout so webhooks for this customer can always be matched to the org.
    await this.db.tx({ orgId: org.id }, (c) =>
      c.query('UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1', [org.id, customer.id]),
    )
    return customer.id
  }

  async checkout(org: BillingOrg, plan: PaidPlan, email: string, urls: { success: string; cancel: string }) {
    const price = this.priceFor(plan)

    // Already subscribed: switch the price on the existing subscription. The
    // resulting customer.subscription.updated webhook changes the plan.
    if (org.stripe_subscription_id && org.subscription_status !== 'canceled') {
      const sub = await this.stripe.subscriptions.retrieve(org.stripe_subscription_id)
      await this.stripe.subscriptions.update(sub.id, {
        items: [{ id: sub.items.data[0].id, price }],
        proration_behavior: 'create_prorations',
        metadata: { orgId: org.id },
      })
      return null
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: await this.customerFor(org, email),
      client_reference_id: org.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { orgId: org.id } },
      success_url: urls.success,
      cancel_url: urls.cancel,
    })
    if (!session.url) throw new HttpError(502, 'stripe_error', 'Stripe did not return a checkout URL.')
    return session.url
  }

  async portal(org: BillingOrg, returnUrl: string) {
    if (!org.stripe_customer_id) throw new HttpError(400, 'no_customer', 'This organization has no billing account yet.')
    const session = await this.stripe.billingPortal.sessions.create({ customer: org.stripe_customer_id, return_url: returnUrl })
    return session.url
  }

  async invoices(org: BillingOrg): Promise<Invoice[]> {
    if (!org.stripe_customer_id) return []
    const list = await this.stripe.invoices.list({ customer: org.stripe_customer_id, limit: 12 })
    return list.data.map((inv) => ({
      id: inv.id ?? '',
      number: inv.number,
      date: new Date(inv.created * 1000).toISOString(),
      amount: inv.amount_paid || inv.amount_due,
      currency: inv.currency,
      status: inv.status,
      pdfUrl: inv.invoice_pdf ?? null,
    }))
  }
}

/**
 * Billing without a Stripe account, for local development and the public demo.
 * "Checkout" is a signed link back to our own server that applies the plan
 * through the same code path a real webhook uses (applySubscription).
 */
export class DemoBilling implements BillingProvider {
  readonly mode = 'demo' as const

  constructor(
    private secret: string,
    private apiBase: string,
  ) {}

  async checkout(org: BillingOrg, plan: PaidPlan, _email: string, urls: { success: string }) {
    const token = sign({ orgId: org.id, plan, next: urls.success, exp: Date.now() + 10 * 60_000 }, this.secret)
    return `${this.apiBase}/api/billing/demo-checkout?token=${encodeURIComponent(token)}`
  }

  async portal(): Promise<string> {
    throw new HttpError(400, 'demo_billing', 'The billing portal needs Stripe. In demo mode, change plans on this page.')
  }

  async invoices(): Promise<Invoice[]> {
    return []
  }
}
