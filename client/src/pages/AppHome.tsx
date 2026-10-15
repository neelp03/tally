import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { post } from '../api'
import { Corners, Logo } from '../components/ui'
import { useSession } from '../session'

/**
 * /app: go to the first org, or (with no orgs, or at /app/new) create one and
 * accept pending invites.
 */
export default function AppHome({ forceNew = false }: { forceNew?: boolean }) {
  const { user, orgs, invites, loading, refresh, signOut } = useSession()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (loading) return null
  if (!user) return <Navigate to="/signin" replace />
  if (orgs[0] && !forceNew && invites.length === 0) return <Navigate to={`/app/${orgs[0].slug}/overview`} replace />

  const create = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const { org } = await post<{ org: { slug: string } }>('/orgs', { name })
      await refresh()
      navigate(`/app/${org.slug}/overview`)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const accept = async (id: string) => {
    try {
      const { org } = await post<{ org: { slug: string } }>(`/invites/${id}/accept`)
      await refresh()
      navigate(`/app/${org.slug}/overview`)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="center-page mosaic">
      <div className="auth-card panel corners">
        <Corners />
        <div className="auth-logo">
          <Logo />
        </div>
        {invites.length > 0 && (
          <section className="stack">
            <h1 className="onboard-title">You're invited</h1>
            {invites.map((i) => (
              <div key={i.id} className="invite-card">
                <div>
                  <strong>{i.org_name}</strong>
                  <p className="label">as {i.role}</p>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => accept(i.id)}>
                  Join
                </button>
              </div>
            ))}
            {orgs[0] && (
              <button className="btn btn-quiet" onClick={() => navigate(`/app/${orgs[0].slug}/overview`)}>
                Skip for now
              </button>
            )}
            <div className="divider label">or</div>
          </section>
        )}
        <form className="auth-form" onSubmit={create}>
          <h1 className="onboard-title">Create an organization</h1>
          <p className="muted">Your team, boards and billing live in an organization. You can create more later.</p>
          <label className="field">
            <span className="label">Organization name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus={invites.length === 0} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="btn btn-primary btn-block">Create organization</button>
          {orgs[0] && forceNew && (
            <button type="button" className="btn btn-quiet btn-block" onClick={() => navigate(-1)}>
              Cancel
            </button>
          )}
        </form>
        <button className="btn btn-quiet btn-sm auth-signout" onClick={() => signOut().then(() => navigate('/'))}>
          Sign out ({user.email})
        </button>
      </div>
    </div>
  )
}
