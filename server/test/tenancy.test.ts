import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import type { Tally } from '../src/app.js'
import { connect } from '../src/db.js'
import { APP_URL, OWNER_URL, signUp, startTestServer } from './helpers.js'

let tally: Tally
let a: Awaited<ReturnType<typeof signUp>>
let b: Awaited<ReturnType<typeof signUp>>
let boardA: string
let boardB: string

before(async () => {
  tally = await startTestServer()
  a = await signUp(tally.url, 'Org A')
  b = await signUp(tally.url, 'Org B')
  boardA = (await a.client.get(`/api/orgs/${a.orgId}/boards`)).data.boards[0].id
  boardB = (await b.client.get(`/api/orgs/${b.orgId}/boards`)).data.boards[0].id
  await a.client.post(`/api/orgs/${a.orgId}/posts`, { boardId: boardA, title: 'A secret plan', body: 'only for A' })
  await b.client.post(`/api/orgs/${b.orgId}/posts`, { boardId: boardB, title: 'B secret plan', body: 'only for B' })
})

after(() => tally.close())

describe('row-level security in the database', () => {
  test('a tenant context only sees its own rows, even with an unfiltered query', async () => {
    const rows = await tally.db.tx({ orgId: a.orgId }, async (c) => (await c.query('SELECT title, org_id FROM posts')).rows)
    assert.deepEqual(
      rows.map((r) => r.title),
      ['A secret plan'],
    )
  })

  test('no tenant context means no tenant rows', async () => {
    const rows = await tally.db.tx({}, async (c) => (await c.query('SELECT * FROM posts')).rows)
    assert.equal(rows.length, 0)
    const audit = await tally.db.tx({}, async (c) => (await c.query('SELECT * FROM audit_logs')).rows)
    assert.equal(audit.length, 0)
  })

  test("a tenant cannot write rows into another tenant's org", async () => {
    await assert.rejects(
      tally.db.tx({ orgId: a.orgId }, (c) =>
        c.query(`INSERT INTO boards (org_id, name, slug) VALUES ($1, 'Injected', 'injected')`, [b.orgId]),
      ),
      /row-level security/,
    )
  })

  test("composite foreign keys stop a row from pointing at another tenant's board", async () => {
    // Even with a valid org_id for A, a post may not reference B's board.
    await assert.rejects(
      tally.db.tx({ orgId: a.orgId }, (c) =>
        c.query(`INSERT INTO posts (org_id, board_id, number, title, author_name) VALUES ($1, $2, 999, 'x', 'x')`, [a.orgId, boardB]),
      ),
      /foreign key/,
    )
  })

  test("a tenant cannot update or delete another tenant's rows", async () => {
    const updated = await tally.db.tx({ orgId: a.orgId }, async (c) => (await c.query(`UPDATE posts SET title = 'pwned' WHERE org_id = $1`, [b.orgId])).rowCount)
    const deleted = await tally.db.tx({ orgId: a.orgId }, async (c) => (await c.query('DELETE FROM boards WHERE org_id = $1', [b.orgId])).rowCount)
    assert.equal(updated, 0)
    assert.equal(deleted, 0)
    const stillThere = await tally.db.tx({ orgId: b.orgId }, async (c) => (await c.query('SELECT title FROM posts')).rows[0].title)
    assert.equal(stillThere, 'B secret plan')
  })

  test('tenant settings do not leak between pooled connections', async () => {
    // Run many alternating transactions on a small pool; each must only see its own org.
    const db = connect(APP_URL, 2)
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const org = i % 2 ? a.orgId : b.orgId
          return db.tx({ orgId: org }, async (c) => ({ org, ids: (await c.query('SELECT DISTINCT org_id FROM posts')).rows.map((r) => r.org_id) }))
        }),
      )
      for (const r of results) assert.deepEqual(r.ids, [r.org])
      const outside = await db.pool.query('SELECT count(*)::int AS n FROM posts')
      assert.equal(outside.rows[0].n, 0)
    } finally {
      await db.close()
    }
  })

  test('the server refuses to run as a role that bypasses RLS', async () => {
    const owner = connect(OWNER_URL, 1)
    await assert.rejects(owner.assertRlsEnforced(), /BYPASSRLS/)
    await owner.close()
  })

  test('every table with an org_id has row-level security forced on', async () => {
    const c = new pg.Client({ connectionString: OWNER_URL })
    await c.connect()
    const { rows } = await c.query(
      `SELECT t.relname, t.relrowsecurity, t.relforcerowsecurity
         FROM pg_class t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'org_id'
        WHERE t.relkind = 'r' AND t.relnamespace = 'public'::regnamespace`,
    )
    await c.end()
    assert.ok(rows.length >= 9)
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.relname} lacks forced RLS`)
  })
})

describe('tenant isolation through the API', () => {
  test("members of one org get 404 for another org's endpoints", async () => {
    for (const path of ['', '/overview', '/posts', '/boards', '/members', '/audit-log', '/billing', '/api-keys']) {
      const res = await a.client.get(`/api/orgs/${b.orgId}${path}`)
      assert.equal(res.status, 404, `GET /api/orgs/:b${path} returned ${res.status}`)
    }
  })

  test("an org's own routes cannot reach another org's post by id", async () => {
    const postB = (await b.client.get(`/api/orgs/${b.orgId}/posts`)).data.posts[0]
    const res = await a.client.get(`/api/orgs/${a.orgId}/posts/${postB.id}`)
    assert.equal(res.status, 404)
    const patch = await a.client.patch(`/api/orgs/${a.orgId}/posts/${postB.id}`, { status: 'closed' })
    assert.equal(patch.status, 404)
  })

  test("a post cannot be created on another org's board", async () => {
    const res = await a.client.post(`/api/orgs/${a.orgId}/posts`, { boardId: boardB, title: 'sneaky post' })
    assert.equal(res.status, 404)
    const titles = (await b.client.get(`/api/orgs/${b.orgId}/posts`)).data.posts.map((p: any) => p.title)
    assert.deepEqual(titles, ['B secret plan'])
  })

  test('org listing only includes my orgs', async () => {
    const me = await a.client.get('/api/me')
    assert.deepEqual(
      me.data.orgs.map((o: any) => o.name),
      ['Org A'],
    )
  })
})
