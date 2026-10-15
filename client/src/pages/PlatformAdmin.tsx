import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { fmt, get, shortDate, type Plan } from '../api'
import { Logo } from '../components/ui'
import { useSession } from '../session'

interface AdminData {
  orgs: {
    id: string
    name: string
    slug: string
    plan: Plan
    subscription_status: string | null
    created_at: string
    is_demo: boolean
    posts_this_period: number
    api_calls_this_period: number
    mrr: number
  }[]
  totals: { orgs: number; mrr: number; byPlan: Record<Plan, number> }
}

/** Cross-tenant view for platform staff. Reads only the organizations table: no customer content. */
export default function PlatformAdmin() {
  const { user, loading } = useSession()
  const [data, setData] = useState<AdminData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (user?.is_platform_admin) get<AdminData>('/admin/orgs').then(setData).catch((e) => setError(e.message))
  }, [user])

  if (loading) return null
  if (!user) return <Navigate to="/signin" replace />

  return (
    <div className="admin-page">
      <header className="site-nav">
        <Logo to="/app" />
        <span className="label">Platform admin</span>
        <Link className="btn btn-sm" to="/app">
          Back to app
        </Link>
      </header>
      <main className="page">
        {!user.is_platform_admin && <p className="notice notice-error">Platform admins only.</p>}
        {error && <p className="notice notice-error">{error}</p>}
        {data && (
          <>
            <div className="bento stats">
              <div className="stat">
                <span className="label">Organizations</span>
                <strong>{fmt(data.totals.orgs)}</strong>
              </div>
              <div className="stat">
                <span className="label">MRR (excl. demo)</span>
                <strong>${fmt(data.totals.mrr)}</strong>
              </div>
              <div className="stat">
                <span className="label">Pro</span>
                <strong>{data.totals.byPlan.pro}</strong>
              </div>
              <div className="stat">
                <span className="label">Business</span>
                <strong>{data.totals.byPlan.business}</strong>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th className="num">Posts / mo</th>
                  <th className="num">API calls / mo</th>
                  <th className="num">MRR</th>
                  <th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.orgs.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong> <span className="mono muted">/{o.slug}</span>
                      {o.is_demo && <span className="chip chip-internal"> demo</span>}
                    </td>
                    <td>
                      <span className="label ink">{o.plan}</span>
                    </td>
                    <td className="muted">{o.subscription_status ?? '—'}</td>
                    <td className="num">{fmt(o.posts_this_period)}</td>
                    <td className="num">{fmt(o.api_calls_this_period)}</td>
                    <td className="num">${o.mrr}</td>
                    <td className="num muted">{shortDate(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  )
}
