import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Stripe from 'stripe'
import type { Tally } from '../src/app.js'
import { asOwner, Client, signUp, startTestServer } from './helpers.js'

const WEBHOOK_SECRET = 'whsec_test_secret'
let tally: Tally

before(async () => {
  tally = await startTestServer({ stripeWebhookSecret: WEBHOOK_SECRET })
})
after(() => tally.close())

function subscriptionEvent(
  id: string,
  type: string,
  sub: { orgId: string; status: string; price: string | null; customer?: string },
  createdSecondsAgo = 0,
) {
  return {
    id,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000) - createdSecondsAgo,
    data: {
      object: {
        id: `sub_${sub.orgId.slice(0, 8)}`,
        object: 'subscription',
        status: sub.status,
        customer: sub.customer ?? `cus_${sub.orgId.slice(0, 8)}`,
        metadata: { orgId: sub.orgId },
        items: { data: [{ id: 'si_1', price: { id: sub.price }, current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30 }] },
      },
    },
  }
}

async function sendWebhook(event: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event)
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret })
  const res = await fetch(`${tally.url}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  })
  return { status: res.status, data: await res.json() }
}

const planOf = async (orgId: string) => (await asOwner('SELECT plan, subscription_status FROM organizations WHERE id = $1', [orgId]))[0]

describe('Stripe webhooks', () => {
  test('a signed subscription event changes the plan and is audited', async () => {
    const o = await signUp(tally.url)
    const res = await sendWebhook(subscriptionEvent('evt_1', 'customer.subscription.updated', { orgId: o.orgId, status: 'active', price: 'demo_price_pro' }))
    assert.equal(res.status, 200)
    assert.equal(res.data.result, 'applied')
    assert.deepEqual(await planOf(o.orgId), { plan: 'pro', subscription_status: 'active' })
    const audit = (await o.client.get(`/api/orgs/${o.orgId}/audit-log`)).data.entries
    assert.equal(audit[0].action, 'subscription.updated')
    assert.equal(audit[0].actor_label, 'Stripe')
  })

  test('a retried event is applied once', async () => {
    const o = await signUp(tally.url)
    const event = subscriptionEvent('evt_dup', 'customer.subscription.updated', { orgId: o.orgId, status: 'active', price: 'demo_price_business' })
    assert.equal((await sendWebhook(event)).data.result, 'applied')
    assert.equal((await sendWebhook(event)).data.result, 'duplicate')
  })

  test('an older event arriving late does not overwrite a newer one', async () => {
    const o = await signUp(tally.url)
    await sendWebhook(subscriptionEvent('evt_new', 'customer.subscription.updated', { orgId: o.orgId, status: 'active', price: 'demo_price_business' }))
    const stale = await sendWebhook(subscriptionEvent('evt_old', 'customer.subscription.updated', { orgId: o.orgId, status: 'active', price: 'demo_price_pro' }, 600))
    assert.equal(stale.data.result, 'stale')
    assert.equal((await planOf(o.orgId)).plan, 'business')
  })

  test('a canceled subscription drops the org to Free', async () => {
    const o = await signUp(tally.url)
    await sendWebhook(subscriptionEvent('evt_a', 'customer.subscription.created', { orgId: o.orgId, status: 'active', price: 'demo_price_pro' }, 10))
    await sendWebhook(subscriptionEvent('evt_b', 'customer.subscription.deleted', { orgId: o.orgId, status: 'canceled', price: 'demo_price_pro' }))
    assert.deepEqual(await planOf(o.orgId), { plan: 'free', subscription_status: 'canceled' })
  })

  test('the org is found by Stripe customer id when metadata is missing', async () => {
    const o = await signUp(tally.url)
    await asOwner(`UPDATE organizations SET stripe_customer_id = 'cus_lookup' WHERE id = $1`, [o.orgId])
    const event = subscriptionEvent('evt_cus', 'customer.subscription.updated', { orgId: o.orgId, status: 'active', price: 'demo_price_pro', customer: 'cus_lookup' })
    ;(event.data.object as any).metadata = {}
    assert.equal((await sendWebhook(event)).data.result, 'applied')
    assert.equal((await planOf(o.orgId)).plan, 'pro')
  })

  test('a bad signature is rejected and changes nothing', async () => {
    const o = await signUp(tally.url)
    const res = await sendWebhook(subscriptionEvent('evt_bad', 'customer.subscription.updated', { orgId: o.orgId, status: 'active', price: 'demo_price_pro' }), 'whsec_wrong')
    assert.equal(res.status, 400)
    assert.equal((await planOf(o.orgId)).plan, 'free')
  })

  test('unknown event types are acknowledged', async () => {
    const res = await sendWebhook({ id: 'evt_other', object: 'event', type: 'charge.refunded', created: 1, data: { object: {} } })
    assert.equal(res.status, 200)
    assert.equal(res.data.result, 'ignored')
  })
})

describe('demo billing', () => {
  test('checkout upgrades through the same subscription path, and cancel downgrades', async () => {
    const o = await signUp(tally.url)
    const checkout = await o.client.post(`/api/orgs/${o.orgId}/billing/checkout`, { plan: 'business' })
    assert.equal(checkout.status, 200)
    const url = new URL(checkout.data.url)
    assert.equal(url.pathname, '/api/billing/demo-checkout')

    // The browser follows the link with its session cookie.
    const follow = await o.client.get(url.pathname + url.search)
    assert.equal(follow.status, 302)
    assert.match(follow.headers.get('location') ?? '', /settings\/billing\?checkout=success$/)
    assert.equal((await planOf(o.orgId)).plan, 'business')

    const billing = (await o.client.get(`/api/orgs/${o.orgId}/billing`)).data
    assert.equal(billing.mode, 'demo')
    assert.equal(billing.plan, 'business')

    assert.equal((await o.client.post(`/api/orgs/${o.orgId}/billing/demo-cancel`)).status, 200)
    assert.equal((await planOf(o.orgId)).plan, 'free')
  })

  test('a tampered checkout token is rejected', async () => {
    const o = await signUp(tally.url)
    const { url } = (await o.client.post(`/api/orgs/${o.orgId}/billing/checkout`, { plan: 'pro' })).data
    const token = new URL(url).searchParams.get('token')!
    const [body, mac] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), plan: 'business' })).toString('base64url')
    const res = await o.client.get(`/api/billing/demo-checkout?token=${forged}.${mac}`)
    assert.equal(res.status, 400)
    assert.equal((await planOf(o.orgId)).plan, 'free')
  })

  test('signing out then hitting a checkout link still needs a session', async () => {
    const o = await signUp(tally.url)
    const { url } = (await o.client.post(`/api/orgs/${o.orgId}/billing/checkout`, { plan: 'pro' })).data
    const anon = new Client(tally.url)
    const res = await anon.get(new URL(url).pathname + new URL(url).search)
    assert.equal(res.status, 401)
  })
})
