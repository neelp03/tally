import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Tally } from '../src/app.js'
import { asOwner, Client, signUp, signUpUser, startTestServer } from './helpers.js'

const GOOGLE = { clientId: 'google-client-id', clientSecret: 'google-secret' }
let tally: Tally
let googleClaims: Record<string, unknown> = {}

before(async () => {
  tally = await startTestServer({
    demo: true,
    google: {
      ...GOOGLE,
      // Stand-in for Google's token endpoint: returns an ID token with the claims the test sets.
      fetch: (async () =>
        new Response(
          JSON.stringify({ id_token: `x.${Buffer.from(JSON.stringify(googleClaims)).toString('base64url')}.sig` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    },
  })
})
after(() => tally.close())

async function apiCall(key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${tally.url}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json(), headers: res.headers }
}

async function proOrgWithKey(name = 'API Org') {
  const o = await signUp(tally.url, name)
  await asOwner(`UPDATE organizations SET plan = 'pro' WHERE id = $1`, [o.orgId])
  const created = await o.client.post(`/api/orgs/${o.orgId}/api-keys`, { name: 'CI' })
  assert.equal(created.status, 201)
  return { ...o, key: created.data.secret as string, keyId: created.data.key.id as string }
}

describe('public REST API', () => {
  test('API keys need a paid plan, and the full key is shown once', async () => {
    const free = await signUp(tally.url)
    assert.equal((await free.client.post(`/api/orgs/${free.orgId}/api-keys`, { name: 'x' })).status, 402)

    const o = await proOrgWithKey()
    assert.match(o.key, /^tly_live_[0-9A-Za-z]{32}$/)
    const list = (await o.client.get(`/api/orgs/${o.orgId}/api-keys`)).data.keys
    assert.equal(list.length, 1)
    assert.ok(!JSON.stringify(list).includes(o.key))
    const stored = await asOwner('SELECT key_hash FROM api_keys WHERE id = $1', [o.keyId])
    assert.notEqual(stored[0].key_hash, o.key)
  })

  test('create, list, read and update posts, attributed to the key in the audit log', async () => {
    const o = await proOrgWithKey()
    const created = await apiCall(o.key, 'POST', '/posts', { board: 'feature-requests', title: 'From the API', authorName: 'Zapier' })
    assert.equal(created.status, 201)
    assert.equal(created.data.data.author, 'Zapier')
    const number = created.data.data.number

    const patched = await apiCall(o.key, 'PATCH', `/posts/${number}`, { status: 'planned', tags: ['api'] })
    assert.equal(patched.data.data.status, 'planned')
    assert.deepEqual(patched.data.data.tags, ['api'])

    const list = await apiCall(o.key, 'GET', '/posts?status=planned')
    assert.equal(list.data.data.length, 1)
    assert.equal((await apiCall(o.key, 'GET', '/boards')).data.data[0].slug, 'feature-requests')

    const audit = (await o.client.get(`/api/orgs/${o.orgId}/audit-log`)).data.entries
    const statusEntry = audit.find((e: any) => e.action === 'post.status_changed')
    assert.equal(statusEntry.actor_type, 'api_key')
    assert.equal(statusEntry.actor_label, 'API key: CI')
  })

  test("a key only reaches its own org, even when post numbers overlap", async () => {
    const a = await proOrgWithKey('Keys A')
    const b = await proOrgWithKey('Keys B')
    await apiCall(a.key, 'POST', '/posts', { board: 'feature-requests', title: 'A number one' })
    await apiCall(b.key, 'POST', '/posts', { board: 'feature-requests', title: 'B number one' })
    assert.equal((await apiCall(a.key, 'GET', '/posts/1')).data.data.title, 'A number one')
    assert.equal((await apiCall(b.key, 'GET', '/posts/1')).data.data.title, 'B number one')
    const listA = (await apiCall(a.key, 'GET', '/posts')).data.data.map((p: any) => p.title)
    assert.deepEqual(listA, ['A number one'])
  })

  test('invalid and revoked keys are rejected', async () => {
    const o = await proOrgWithKey()
    assert.equal((await apiCall('tly_live_nope', 'GET', '/boards')).status, 401)
    assert.equal((await fetch(`${tally.url}/api/v1/boards`)).status, 401)
    await o.client.delete(`/api/orgs/${o.orgId}/api-keys/${o.keyId}`)
    assert.equal((await apiCall(o.key, 'GET', '/boards')).status, 401)
  })

  test('per-minute rate limit with headers', async () => {
    const o = await proOrgWithKey()
    let last
    for (let i = 0; i < 121; i++) last = await apiCall(o.key, 'GET', '/boards')
    assert.equal(last!.status, 429)
    assert.equal(last!.data.error.code, 'rate_limited')
    assert.equal(last!.headers.get('x-ratelimit-limit'), '120')
    assert.equal(last!.headers.get('x-ratelimit-remaining'), '0')
    assert.ok(Number(last!.headers.get('retry-after')) > 0)
  })

  test('the monthly API quota is enforced', async () => {
    const o = await proOrgWithKey()
    await asOwner('UPDATE organizations SET api_calls_this_period = 50000 WHERE id = $1', [o.orgId])
    const res = await apiCall(o.key, 'GET', '/boards')
    assert.equal(res.status, 429)
    assert.equal(res.data.error.code, 'usage_limit')
  })

  test('a key stops working when the org drops to Free', async () => {
    const o = await proOrgWithKey()
    await asOwner(`UPDATE organizations SET plan = 'free' WHERE id = $1`, [o.orgId])
    assert.equal((await apiCall(o.key, 'GET', '/boards')).status, 402)
  })
})

describe('accounts and sessions', () => {
  test('state-changing requests need the CSRF header', async () => {
    const o = await signUp(tally.url)
    const res = await o.client.request('POST', `/api/orgs/${o.orgId}/boards`, { name: 'x' }, { 'x-requested-with': '' })
    assert.equal(res.status, 403)
    assert.equal(res.data.error.code, 'csrf')
  })

  test('sign in, sign out, wrong password', async () => {
    const u = await signUpUser(tally.url)
    const fresh = new Client(tally.url)
    assert.equal((await fresh.post('/api/auth/login', { email: u.email, password: 'wrong-password' })).status, 401)
    assert.equal((await fresh.post('/api/auth/login', { email: u.email, password: 'password123' })).status, 200)
    assert.equal((await fresh.get('/api/me')).status, 200)
    await fresh.post('/api/auth/logout')
    assert.equal((await fresh.get('/api/me')).status, 401)
  })

  test('duplicate sign-up is refused', async () => {
    const u = await signUpUser(tally.url)
    const res = await new Client(tally.url).post('/api/auth/register', { name: 'X', email: u.email, password: 'password123' })
    assert.equal(res.status, 409)
  })

  test('an invite shows up for the invited email and joins the org on accept', async () => {
    const o = await signUp(tally.url, 'Inviting Org')
    const u = await signUpUser(tally.url)
    await o.client.post(`/api/orgs/${o.orgId}/invites`, { email: u.email, role: 'admin' })
    const me = (await u.client.get('/api/me')).data
    assert.equal(me.invites.length, 1)
    assert.equal(me.invites[0].org_name, 'Inviting Org')
    // Someone else can't accept it.
    const other = await signUpUser(tally.url)
    assert.equal((await other.client.post(`/api/invites/${me.invites[0].id}/accept`)).status, 404)
    assert.equal((await u.client.post(`/api/invites/${me.invites[0].id}/accept`)).status, 200)
    assert.equal((await u.client.get('/api/me')).data.orgs[0].role, 'admin')
  })
})

describe('Google sign-in and domain capture', () => {
  async function googleSignIn(claims: Record<string, unknown>) {
    googleClaims = { iss: 'https://accounts.google.com', aud: GOOGLE.clientId, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims }
    const client = new Client(tally.url)
    const start = await client.get('/api/auth/google')
    const state = new URL(start.headers.get('location')!).searchParams.get('state')
    const cb = await client.get(`/api/auth/google/callback?state=${state}&code=abc`)
    return { client, location: cb.headers.get('location') }
  }

  test('creates an account from verified Google claims', async () => {
    const { client, location } = await googleSignIn({ sub: 'g-1', email: 'grace@hopper.dev', name: 'Grace Hopper' })
    assert.equal(location, 'http://localhost:5173/app')
    assert.equal((await client.get('/api/me')).data.user.name, 'Grace Hopper')
  })

  test('rejects a token for another app or an unverified email', async () => {
    assert.match((await googleSignIn({ sub: 'g-2', email: 'a@b.dev', aud: 'someone-else' })).location!, /error=google_token/)
    assert.match((await googleSignIn({ sub: 'g-3', email: 'c@d.dev', email_verified: false })).location!, /error=google_token/)
  })

  test('rejects a callback whose state does not match', async () => {
    const client = new Client(tally.url)
    await client.get('/api/auth/google')
    const cb = await client.get('/api/auth/google/callback?state=forged&code=abc')
    assert.match(cb.headers.get('location')!, /error=google_state/)
  })

  test('a Business org that claims a domain gets new Google users from it', async () => {
    const o = await signUp(tally.url, 'Domain Co')
    assert.equal((await o.client.patch(`/api/orgs/${o.orgId}`, { ssoDomain: 'domainco.dev' })).status, 402)
    await asOwner(`UPDATE organizations SET plan = 'business' WHERE id = $1`, [o.orgId])
    assert.equal((await o.client.patch(`/api/orgs/${o.orgId}`, { ssoDomain: 'domainco.dev' })).status, 200)

    const { client } = await googleSignIn({ sub: 'g-dom', email: 'newhire@domainco.dev', name: 'New Hire' })
    const orgs = (await client.get('/api/me')).data.orgs
    assert.deepEqual(
      orgs.map((x: any) => [x.name, x.role]),
      [['Domain Co', 'member']],
    )
  })
})

describe('public board', () => {
  test('anonymous visitors post, vote once (toggle) and comment; internal notes stay private', async () => {
    const o = await signUp(tally.url, 'Public Co')
    const visitor = new Client(tally.url)
    const base = `/api/public/orgs/${o.orgSlug}`

    const created = await visitor.post(`${base}/boards/feature-requests/posts`, { title: 'Add a calendar view', name: 'Pat' })
    assert.equal(created.status, 201)
    let list = (await visitor.get(`${base}/boards/feature-requests/posts`)).data.posts
    assert.equal(list[0].vote_count, 1) // posting counts as a vote
    assert.equal(list[0].voted, true)

    const toggled = await visitor.post(`${base}/posts/${list[0].number}/vote`)
    assert.deepEqual(toggled.data, { voteCount: 0, voted: false })
    await new Client(tally.url).post(`${base}/posts/${list[0].number}/vote`)
    list = (await visitor.get(`${base}/boards/feature-requests/posts`)).data.posts
    assert.equal(list[0].vote_count, 1)
    assert.equal(list[0].voted, false)

    const postId = (await o.client.get(`/api/orgs/${o.orgId}/posts`)).data.posts[0].id
    await o.client.post(`/api/orgs/${o.orgId}/posts/${postId}/comments`, { body: 'internal: big customer', internal: true })
    await o.client.post(`/api/orgs/${o.orgId}/posts/${postId}/comments`, { body: 'We are looking at this.' })
    await visitor.post(`${base}/posts/${list[0].number}/comments`, { body: 'Thanks!', name: 'Pat' })

    const detail = (await visitor.get(`${base}/posts/${list[0].number}`)).data
    assert.deepEqual(
      detail.comments.map((c: any) => [c.body, c.is_team]),
      [
        ['We are looking at this.', true],
        ['Thanks!', false],
      ],
    )
    assert.equal(detail.post.comment_count, 2)
  })

  test('private boards are not reachable publicly', async () => {
    const o = await signUp(tally.url, 'Private Co')
    await asOwner(`UPDATE organizations SET plan = 'pro' WHERE id = $1`, [o.orgId])
    await o.client.post(`/api/orgs/${o.orgId}/boards`, { name: 'Roadmap', isPublic: false })
    const visitor = new Client(tally.url)
    const boards = (await visitor.get(`/api/public/orgs/${o.orgSlug}`)).data.boards.map((b: any) => b.slug)
    assert.deepEqual(boards, ['feature-requests'])
    assert.equal((await visitor.get(`/api/public/orgs/${o.orgSlug}/boards/roadmap/posts`)).status, 404)
  })

  test('merging moves votes (one per voter) and the duplicate forwards to the target', async () => {
    const o = await signUp(tally.url, 'Merge Co')
    const base = `/api/public/orgs/${o.orgSlug}`
    const v1 = new Client(tally.url)
    const v2 = new Client(tally.url)
    await v1.post(`${base}/boards/feature-requests/posts`, { title: 'Export to CSV' }) // v1 votes #1
    await v2.post(`${base}/boards/feature-requests/posts`, { title: 'CSV export please' }) // v2 votes #2
    await v1.post(`${base}/posts/2/vote`) // v1 votes #2 too
    const posts = (await o.client.get(`/api/orgs/${o.orgId}/posts?sort=new`)).data.posts
    const [dup, target] = [posts.find((p: any) => p.number === 2), posts.find((p: any) => p.number === 1)]
    const merged = await o.client.post(`/api/orgs/${o.orgId}/posts/${dup.id}/merge`, { intoId: target.id })
    assert.equal(merged.data.post.vote_count, 2) // v1 once, v2 once
    const forwarded = (await v2.get(`${base}/posts/2`)).data.post
    assert.equal(forwarded.number, 1)
  })
})

describe('audit log export', () => {
  test('CSV export is a Business feature and neutralizes formulas', async () => {
    const o = await signUp(tally.url)
    assert.equal((await o.client.get(`/api/orgs/${o.orgId}/audit-log.csv`)).status, 402)
    await asOwner(`UPDATE organizations SET plan = 'business' WHERE id = $1`, [o.orgId])
    await o.client.post(`/api/orgs/${o.orgId}/boards`, { name: '=HYPERLINK("evil")' })
    const csv = await o.client.get(`/api/orgs/${o.orgId}/audit-log.csv`)
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get('content-type')!, /text\/csv/)
    assert.ok(String(csv.data).includes(`"'=HYPERLINK(""evil"")"`))
  })
})

describe('demo mode', () => {
  test('each visitor gets a private seeded org', async () => {
    const one = new Client(tally.url)
    const two = new Client(tally.url)
    const a = (await one.post('/api/demo')).data.org
    const b = (await two.post('/api/demo')).data.org
    assert.notEqual(a.id, b.id)
    const overview = (await one.get(`/api/orgs/${a.id}/overview`)).data
    assert.ok(overview.stats.openPosts > 5)
    assert.equal((await one.get(`/api/orgs/${b.id}`)).status, 404)
  })
})
