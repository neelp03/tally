import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export type Tx = pg.PoolClient

/**
 * Who the current transaction acts for. These become the `app.*` settings that
 * the row-level security policies read (see migrations/001_init.sql).
 */
export interface TenantContext {
  orgId?: string | null
  userId?: string | null
  userEmail?: string | null
  apiKeyHash?: string | null
}

export class Db {
  constructor(readonly pool: pg.Pool) {}

  /**
   * Run fn in a transaction scoped to a tenant. The settings are transaction-local
   * (`set_config(..., true)`), so they vanish at COMMIT/ROLLBACK and a pooled
   * connection never carries one request's tenant into the next.
   */
  async tx<T>(ctx: TenantContext, fn: (c: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.user_email', $3, true), set_config('app.api_key_hash', $4, true)`,
        [ctx.orgId ?? '', ctx.userId ?? '', ctx.userEmail ?? '', ctx.apiKeyHash ?? ''],
      )
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  /** Row-level security is only a guarantee if this role can't bypass it. */
  async assertRlsEnforced() {
    const { rows } = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    const role = rows[0]
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Database role "${role?.rolname}" is a superuser or has BYPASSRLS, so tenant isolation would not apply. ` +
          'Connect the app with a regular role (APP_DATABASE_URL).',
      )
    }
  }

  close() {
    return this.pool.end()
  }
}

export function connect(url: string, max = 10): Db {
  return new Db(new pg.Pool({ connectionString: url, max }))
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Apply pending migrations as the owner role, then grant the app role the
 * table privileges it needs (no ownership, so policies always apply to it).
 */
export async function migrate(ownerUrl: string, appUrl: string) {
  const owner = new pg.Client({ connectionString: ownerUrl })
  await owner.connect()
  try {
    await owner.query('SELECT pg_advisory_lock(727001)')
    await owner.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const { rows } = await owner.query<{ name: string }>('SELECT name FROM schema_migrations')
    const applied = new Set(rows.map((r) => r.name))
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files) {
      if (applied.has(file)) continue
      await owner.query('BEGIN')
      try {
        await owner.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
        await owner.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await owner.query('COMMIT')
      } catch (err) {
        await owner.query('ROLLBACK')
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
    }

    const appRole = decodeURIComponent(new URL(appUrl).username)
    const ownerRole = decodeURIComponent(new URL(ownerUrl).username)
    if (appRole && appRole !== ownerRole) {
      const role = pg.escapeIdentifier(appRole)
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
      await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
      await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`)
    }
  } finally {
    await owner.query('SELECT pg_advisory_unlock(727001)').catch(() => {})
    await owner.end()
  }
}
