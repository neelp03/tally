import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { agoText, del, get, post, shortDate } from '../../api'
import { useOrg } from '../../components/AppShell'
import { CopyButton, Dialog } from '../../components/ui'

interface Key {
  id: string
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
  created_by: string | null
}

export default function ApiKeys() {
  const { org, base } = useOrg()
  const [keys, setKeys] = useState<Key[]>([])
  const [info, setInfo] = useState<{ apiEnabled: boolean; ratePerMinute: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await get<{ keys: Key[]; apiEnabled: boolean; ratePerMinute: number }>(`/orgs/${org.id}/api-keys`)
    setKeys(data.keys)
    setInfo({ apiEnabled: data.apiEnabled, ratePerMinute: data.ratePerMinute })
  }, [org.id])

  useEffect(() => {
    load()
  }, [load])

  const apiBase = `${location.origin}/api/v1`

  return (
    <section className="settings-section">
      <div className="settings-head">
        <div>
          <h2>API keys</h2>
          <p className="muted">Keys give read and write access to this organization's boards and posts. Keep them secret.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!info?.apiEnabled}>
          + Create key
        </button>
      </div>

      {info && !info.apiEnabled && (
        <p className="notice notice-warn">
          The API needs the Pro or Business plan. <Link to={`${base}/settings/billing`}>See plans</Link>
        </p>
      )}
      {info?.apiEnabled && <p className="label">Rate limit {info.ratePerMinute} requests / minute on {org.limits.name}</p>}
      {error && <p className="notice notice-error">{error}</p>}

      {keys.length === 0 ? (
        <p className="muted">No keys yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>
                  <strong>{k.name}</strong>
                  {k.created_by && <span className="muted"> by {k.created_by}</span>}
                </td>
                <td className="mono">{k.prefix}••••</td>
                <td className="mono muted">{shortDate(k.created_at)}</td>
                <td className="mono muted">{k.last_used_at ? `${agoText(k.last_used_at)}` : 'Never'}</td>
                <td className="cell-actions">
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!confirm(`Revoke "${k.name}"? Apps using it stop working immediately.`)) return
                      try {
                        await del(`/orgs/${org.id}/api-keys/${k.id}`)
                        await load()
                      } catch (err) {
                        setError((err as Error).message)
                      }
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="sub-head">Example request</h3>
      <pre className="code">
        {`curl ${apiBase}/posts?status=planned \\
  -H "Authorization: Bearer tly_live_…"

curl -X POST ${apiBase}/posts \\
  -H "Authorization: Bearer tly_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"board": "feature-requests", "title": "Sync with Salesforce"}'`}
      </pre>
      <p className="muted">
        Endpoints: <span className="mono">GET /boards</span>, <span className="mono">GET /posts</span>, <span className="mono">GET /posts/:number</span>,{' '}
        <span className="mono">POST /posts</span>, <span className="mono">PATCH /posts/:number</span>. Responses carry{' '}
        <span className="mono">X-RateLimit-*</span> headers.
      </p>

      {creating && <CreateKeyDialog onClose={() => setCreating(false)} onCreated={load} />}
    </section>
  )
}

function CreateKeyDialog({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const { org } = useOrg()
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const res = await post<{ secret: string }>(`/orgs/${org.id}/api-keys`, { name })
      setSecret(res.secret)
      onCreated()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Dialog
      title="Create API key"
      onClose={onClose}
      footer={
        secret && (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        )
      }
    >
      {!secret ? (
        <form className="dialog-form" onSubmit={submit}>
          <label className="field">
            <span className="label">Key name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier sync" required maxLength={60} autoFocus />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary">Create key</button>
          </div>
        </form>
      ) : (
        <>
          <p className="notice notice-warn">Copy this key now. You won't see it again.</p>
          <div className="secret-row">
            <input className="input mono" value={secret} readOnly onFocus={(e) => e.target.select()} aria-label="Secret key" />
            <CopyButton text={secret} />
          </div>
        </>
      )}
    </Dialog>
  )
}
