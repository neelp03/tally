import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { agoText, del, get, patch, post, type Role } from '../../api'
import { useOrg } from '../../components/AppShell'
import { Avatar, CopyButton, Meter, useToast } from '../../components/ui'
import { useSession } from '../../session'

interface Member {
  id: string
  name: string
  email: string
  role: Role
  last_active_at: string | null
  created_at: string
}

interface Invite {
  id: string
  email: string
  role: Role
  created_at: string
}

export default function Members() {
  const { org, reload } = useOrg()
  const { user, refresh } = useSession()
  const navigate = useNavigate()
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [error, setError] = useState<string | null>(null)
  const [toast, notify] = useToast()
  const canManage = org.role !== 'member'

  const load = useCallback(async () => {
    const data = await get<{ members: Member[]; invites: Invite[] }>(`/orgs/${org.id}/members`)
    setMembers(data.members)
    setInvites(data.invites)
  }, [org.id])

  useEffect(() => {
    load()
  }, [load])

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setError(null)
    try {
      await action()
      await Promise.all([load(), reload()])
      if (done) notify(done)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const invite = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      await post(`/orgs/${org.id}/invites`, { email, role })
      setEmail('')
    }, `Invite created for ${email}.`)
  }

  const canEditRole = (m: Member) => canManage && m.role !== 'owner' && m.id !== user!.id && (org.role === 'owner' || m.role === 'member')
  const signupLink = `${location.origin}/signup`

  return (
    <section className="settings-section">
      <div className="settings-head">
        <h2>Members</h2>
        <div className="settings-meter">
          <Meter label="Seats" used={org.usage.seats.used} limit={org.usage.seats.limit} />
        </div>
      </div>

      {canManage && (
        <form className="invite-row" onSubmit={invite}>
          <input className="input" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email to invite" />
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')} aria-label="Role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn btn-primary">Send invite</button>
        </form>
      )}
      {error && <p className="notice notice-error">{error}</p>}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Last active</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>
                <span className="person">
                  <Avatar name={m.name} />
                  <span>
                    <strong>{m.name}</strong>
                    {m.id === user!.id && <span className="muted"> (you)</span>}
                    <br />
                    <span className="muted">{m.email}</span>
                  </span>
                </span>
              </td>
              <td>
                {canEditRole(m) ? (
                  <select
                    className="select select-sm"
                    value={m.role}
                    aria-label={`Role for ${m.name}`}
                    onChange={(e) => run(() => patch(`/orgs/${org.id}/members/${m.id}`, { role: e.target.value }), `${m.name} is now ${e.target.value}.`)}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className="label ink">{m.role}</span>
                )}
              </td>
              <td className="mono muted">{m.last_active_at ? `${agoText(m.last_active_at)}` : '—'}</td>
              <td className="cell-actions">
                {m.id === user!.id && m.role !== 'owner' ? (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={async () => {
                      if (!confirm(`Leave ${org.name}?`)) return
                      await del(`/orgs/${org.id}/members/${m.id}`)
                      await refresh()
                      navigate('/app')
                    }}
                  >
                    Leave
                  </button>
                ) : (
                  canEditRole(m) && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => {
                        if (confirm(`Remove ${m.name} from ${org.name}?`)) run(() => del(`/orgs/${org.id}/members/${m.id}`), `${m.name} was removed.`)
                      }}
                    >
                      Remove
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {invites.length > 0 && (
        <>
          <h3 className="sub-head">Pending invites</h3>
          <p className="muted">
            Invited people see the invite after they sign in with that email. Send them the sign-up link: <CopyButton text={signupLink} label="Copy sign-up link" />
          </p>
          <table className="table">
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>
                    <span className="label ink">{i.role}</span>
                  </td>
                  <td className="mono muted">sent {agoText(i.created_at)}</td>
                  <td className="cell-actions">
                    {canManage && (
                      <button className="btn btn-danger btn-sm" onClick={() => run(() => del(`/orgs/${org.id}/invites/${i.id}`), 'Invite revoked.')}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {toast}
    </section>
  )
}
