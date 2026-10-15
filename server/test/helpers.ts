import pg from 'pg'
import { startTally, type Tally, type TallyOptions } from '../src/app.js'

export const OWNER_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tally_owner:tally_owner@localhost:5433/tally_test'
export const APP_URL = process.env.TEST_APP_DATABASE_URL ?? 'postgres://tally_app:tally_app@localhost:5433/tally_test'

/** Drop everything so each test file migrates a clean database. */
export async function resetDatabase() {
  const c = new pg.Client({ connectionString: OWNER_URL })
  await c.connect()
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await c.end()
}

export async function startTestServer(opts: Partial<TallyOptions> = {}): Promise<Tally> {
  await resetDatabase()
  return startTally({
    ownerUrl: OWNER_URL,
    appUrl: APP_URL,
    secret: 'test-secret',
    publicUrl: 'http://localhost:5173',
    accountsPerMinute: 10_000,
    ...opts,
  })
}

/** A browser-like client: keeps cookies and sends the CSRF header. */
export class Client {
  private cookies = new Map<string, string>()

  constructor(readonly base: string) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: {
        'x-requested-with': 'tally',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      const value = pair.slice(i + 1)
      if (value) this.cookies.set(pair.slice(0, i), value)
      else this.cookies.delete(pair.slice(0, i))
    }
    const text = await res.text()
    let data: T
    try {
      data = text ? JSON.parse(text) : (null as T)
    } catch {
      data = text as T
    }
    return { status: res.status, data, headers: res.headers }
  }

  get = <T = any>(path: string) => this.request<T>('GET', path)
  post = <T = any>(path: string, body: unknown = {}) => this.request<T>('POST', path, body)
  patch = <T = any>(path: string, body: unknown) => this.request<T>('PATCH', path, body)
  delete = <T = any>(path: string) => this.request<T>('DELETE', path)
}

let counter = 0

/** Sign up a new user with a new org. Returns the client and the org id. */
export async function signUp(base: string, orgName = 'Acme') {
  const client = new Client(base)
  const email = `user${++counter}-${Date.now()}@example.com`
  const res = await client.post('/api/auth/register', { name: `User ${counter}`, email, password: 'password123', orgName })
  if (res.status !== 201) throw new Error(`sign up failed: ${JSON.stringify(res.data)}`)
  return { client, email, orgId: res.data.org.id as string, orgSlug: res.data.org.slug as string }
}

/** Sign up a user without an org. */
export async function signUpUser(base: string) {
  const client = new Client(base)
  const email = `person${++counter}-${Date.now()}@example.com`
  await client.post('/api/auth/register', { name: `Person ${counter}`, email, password: 'password123' })
  return { client, email }
}

/** Invite `email` into the org and accept from `invitee`. */
export async function addMember(owner: Client, orgId: string, invitee: Client, email: string, role: 'admin' | 'member' = 'member') {
  const invite = await owner.post(`/api/orgs/${orgId}/invites`, { email, role })
  if (invite.status !== 201) throw new Error(`invite failed: ${JSON.stringify(invite.data)}`)
  const accepted = await invitee.post(`/api/invites/${invite.data.invite.id}/accept`)
  if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.data)}`)
}

/** Run SQL as the owner (bypasses RLS) to set up state the API wouldn't allow directly. */
export async function asOwner<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: OWNER_URL })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows as T[]
  } finally {
    await c.end()
  }
}
