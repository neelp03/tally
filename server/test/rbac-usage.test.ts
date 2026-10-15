import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Tally } from '../src/app.js'
import { can, canChangeRole } from '../src/rbac.js'
import { addMember, asOwner, signUp, signUpUser, startTestServer } from './helpers.js'

let tally: Tally

before(async () => {
  tally = await startTestServer()
})
after(() => tally.close())

describe('role rules', () => {
  test('permission table', () => {
    assert.ok(can('member', 'posts.triage'))
    assert.ok(!can('member', 'boards.manage'))
    assert.ok(can('admin', 'members.manage'))
    assert.ok(!can('admin', 'billing.manage'))
    assert.ok(can('owner', 'billing.manage'))
  })

  test('role changes: nobody becomes or stops being owner, only the owner changes admins', () => {
    assert.ok(canChangeRole('owner', 'member', 'admin'))
    assert.ok(canChangeRole('owner', 'admin', 'member'))
    assert.ok(canChangeRole('admin', 'member', 'admin'))
    assert.ok(!canChangeRole('admin', 'admin', 'member'))
    assert.ok(!canChangeRole('owner', 'member', 'owner'))
    assert.ok(!canChangeRole('admin', 'owner', 'member'))
    assert.ok(!canChangeRole('member', 'member', 'admin'))
  })

  test('members can triage but not manage boards, members, keys, billing or the audit log', async () => {
    const owner = await signUp(tally.url)
    const m = await signUpUser(tally.url)
    await addMember(owner.client, owner.orgId, m.client, m.email, 'member')
    const base = `/api/orgs/${owner.orgId}`
    const board = (await m.client.get(`${base}/boards`)).data.boards[0].id

    assert.equal((await m.client.post(`${base}/posts`, { boardId: board, title: 'Member post' })).status, 201)
    assert.equal((await m.client.post(`${base}/boards`, { name: 'Nope' })).status, 403)
    assert.equal((await m.client.post(`${base}/invites`, { email: 'x@example.com' })).status, 403)
    assert.equal((await m.client.get(`${base}/api-keys`)).status, 403)
    assert.equal((await m.client.get(`${base}/audit-log`)).status, 403)
    assert.equal((await m.client.get(`${base}/billing`)).status, 403)
    assert.equal((await m.client.patch(base, { name: 'Renamed' })).status, 403)
  })

  test('admins manage members but cannot touch the owner, and only owners manage billing', async () => {
    const owner = await signUp(tally.url)
    await asOwner(`UPDATE organizations SET plan = 'business' WHERE id = $1`, [owner.orgId])
    const admin = await signUpUser(tally.url)
    const admin2 = await signUpUser(tally.url)
    await addMember(owner.client, owner.orgId, admin.client, admin.email, 'admin')
    await addMember(owner.client, owner.orgId, admin2.client, admin2.email, 'admin')
    const base = `/api/orgs/${owner.orgId}`
    const members = (await owner.client.get(`${base}/members`)).data.members
    const ownerId = members.find((m: any) => m.role === 'owner').id
    const admin2Id = members.find((m: any) => m.email === admin2.email).id

    assert.equal((await admin.client.patch(`${base}/members/${ownerId}`, { role: 'member' })).status, 403)
    assert.equal((await admin.client.delete(`${base}/members/${ownerId}`)).status, 403)
    assert.equal((await admin.client.patch(`${base}/members/${admin2Id}`, { role: 'member' })).status, 403)
    assert.equal((await admin.client.delete(`${base}/members/${admin2Id}`)).status, 403)
    assert.equal((await admin.client.post(`${base}/billing/checkout`, { plan: 'pro' })).status, 403)
    assert.equal((await admin.client.get(`${base}/billing`)).status, 200)

    // The owner can demote an admin; an admin can leave on their own.
    assert.equal((await owner.client.patch(`${base}/members/${admin2Id}`, { role: 'member' })).status, 200)
    assert.equal((await admin2.client.delete(`${base}/members/${admin2Id}`)).status, 204)
    assert.equal((await admin2.client.get(base)).status, 404)
  })
})

describe('plan usage limits', () => {
  test('Free allows one board', async () => {
    const o = await signUp(tally.url)
    const res = await o.client.post(`/api/orgs/${o.orgId}/boards`, { name: 'Second board' })
    assert.equal(res.status, 402)
    assert.equal(res.data.error.code, 'usage_limit')
    assert.equal(res.data.error.limit, 1)
  })

  test('Free allows two seats, and a pending invite holds a seat', async () => {
    const o = await signUp(tally.url)
    assert.equal((await o.client.post(`/api/orgs/${o.orgId}/invites`, { email: 'one@example.com' })).status, 201)
    const res = await o.client.post(`/api/orgs/${o.orgId}/invites`, { email: 'two@example.com' })
    assert.equal(res.status, 402)
    assert.equal(res.data.error.resource, 'seats')
  })

  test('the monthly post limit is enforced and resets in a new month', async () => {
    const o = await signUp(tally.url)
    const base = `/api/orgs/${o.orgId}`
    const board = (await o.client.get(`${base}/boards`)).data.boards[0].id
    await asOwner('UPDATE organizations SET posts_this_period = 49 WHERE id = $1', [o.orgId])
    assert.equal((await o.client.post(`${base}/posts`, { boardId: board, title: 'Post fifty' })).status, 201)
    const over = await o.client.post(`${base}/posts`, { boardId: board, title: 'Post fifty-one' })
    assert.equal(over.status, 402)

    await asOwner(`UPDATE organizations SET usage_period_start = date_trunc('month', now() - interval '1 month') WHERE id = $1`, [o.orgId])
    assert.equal((await o.client.post(`${base}/posts`, { boardId: board, title: 'New month post' })).status, 201)
    const org = (await o.client.get(base)).data.org
    assert.equal(org.usage.posts.used, 1)
  })

  test('concurrent requests cannot exceed the limit', async () => {
    const o = await signUp(tally.url)
    const base = `/api/orgs/${o.orgId}`
    const board = (await o.client.get(`${base}/boards`)).data.boards[0].id
    await asOwner('UPDATE organizations SET posts_this_period = 45 WHERE id = $1', [o.orgId])
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => o.client.post(`${base}/posts`, { boardId: board, title: `Race ${i}` })),
    )
    assert.equal(results.filter((r) => r.status === 201).length, 5)
    assert.equal(results.filter((r) => r.status === 402).length, 7)
    const numbers = (await o.client.get(`${base}/posts?limit=100`)).data.posts.map((p: any) => p.number)
    assert.equal(new Set(numbers).size, 5)
  })

  test('downgrading keeps data but blocks new usage', async () => {
    const o = await signUp(tally.url)
    await asOwner(`UPDATE organizations SET plan = 'pro' WHERE id = $1`, [o.orgId])
    assert.equal((await o.client.post(`/api/orgs/${o.orgId}/boards`, { name: 'Two' })).status, 201)
    await asOwner(`UPDATE organizations SET plan = 'free' WHERE id = $1`, [o.orgId])
    assert.equal((await o.client.get(`/api/orgs/${o.orgId}/boards`)).data.boards.length, 2)
    assert.equal((await o.client.post(`/api/orgs/${o.orgId}/boards`, { name: 'Three' })).status, 402)
  })
})
