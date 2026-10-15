import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { patch } from '../../api'
import { useOrg } from '../../components/AppShell'
import { useSession } from '../../session'

export default function Security() {
  const { org, base, reload } = useOrg()
  const { config } = useSession()
  const [name, setName] = useState(org.name)
  const [domain, setDomain] = useState(org.sso_domain ?? '')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const ssoAllowed = org.limits.ssoDomain

  const save = (body: object, done: string) => async (e: FormEvent) => {
    e.preventDefault()
    setMessage(null)
    try {
      await patch(`/orgs/${org.id}`, body)
      await reload()
      setMessage({ ok: true, text: done })
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message })
    }
  }

  return (
    <section className="settings-section narrow">
      {message && <p className={`notice ${message.ok ? 'notice-ok' : 'notice-error'}`}>{message.text}</p>}

      <h2>Organization</h2>
      <form className="panel panel-body stack" onSubmit={save({ name }, 'Organization name saved.')}>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <p className="muted">
          Public board address: <span className="mono">/b/{org.slug}</span>
        </p>
        <div>
          <button className="btn btn-primary">Save name</button>
        </div>
      </form>

      <h2>Single sign-on</h2>
      <form className="panel panel-body stack" onSubmit={save({ ssoDomain: domain.trim() || null }, domain.trim() ? `People who sign in with Google using an @${domain.trim()} address now join automatically.` : 'Domain sign-in turned off.')}>
        <p>
          Claim your company's email domain. Anyone who signs in with Google using a verified address on that domain joins this organization as a
          member, if a seat is free.
        </p>
        {!config.googleEnabled && <p className="notice notice-warn">Google sign-in is not configured on this server, so this setting has no effect yet.</p>}
        {!ssoAllowed && (
          <p className="notice notice-warn">
            This needs the Business plan. <Link to={`${base}/settings/billing`}>See plans</Link>
          </p>
        )}
        <label className="field">
          <span className="label">Email domain</span>
          <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="northwind.app" disabled={!ssoAllowed} />
        </label>
        <div>
          <button className="btn btn-primary" disabled={!ssoAllowed}>
            Save domain
          </button>
        </div>
      </form>

      <h2>Data isolation</h2>
      <div className="panel panel-body">
        <p className="muted">
          Every row of this organization's data is tagged with its ID, and PostgreSQL row-level security blocks access from any other organization, even
          if an application query forgets a filter.
        </p>
      </div>
    </section>
  )
}
