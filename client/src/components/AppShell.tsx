import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import { get, type OrgDetail, type PlanLimits, type Plan } from '../api'
import { useSession } from '../session'
import { Avatar, Meter } from './ui'

interface OrgState {
  org: OrgDetail
  plans: Record<Plan, PlanLimits>
  billingMode: 'stripe' | 'demo'
  base: string
  reload(): Promise<void>
}

const OrgContext = createContext<OrgState | null>(null)

export function useOrg(): OrgState {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg must be used inside AppShell')
  return ctx
}

const NAV = [
  { to: 'overview', label: 'Overview', icon: 'M4 16V10M10 16V4M16 16v-8' },
  { to: 'inbox', label: 'Inbox', icon: 'M3 11h4l1 2h4l1-2h4M3 11l2-6h10l2 6v5H3z' },
  { to: 'boards', label: 'Boards', icon: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z' },
  { to: 'settings', label: 'Settings', icon: 'M10 7a3 3 0 100 6 3 3 0 000-6zM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4' },
]

function Icon({ d }: { d: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d={d} />
    </svg>
  )
}

/** Layout for /app/:orgSlug/*. Resolves the slug to one of the user's orgs and loads it. */
export default function AppShell() {
  const { orgSlug } = useParams()
  const { user, orgs, loading, signOut } = useSession()
  const navigate = useNavigate()
  const summary = orgs.find((o) => o.slug === orgSlug)
  const [state, setState] = useState<Omit<OrgState, 'reload' | 'base'> | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const reload = useCallback(async () => {
    if (!summary) return
    const data = await get<{ org: OrgDetail; plans: Record<Plan, PlanLimits>; billingMode: 'stripe' | 'demo' }>(`/orgs/${summary.id}`)
    setState({ org: data.org, plans: data.plans, billingMode: data.billingMode })
  }, [summary])

  useEffect(() => {
    setState(null)
    reload().catch(() => {})
  }, [reload])

  if (loading) return null
  if (!user) return <Navigate to="/signin" replace />
  if (!summary) return <Navigate to="/app" replace />
  if (!state) return <div className="app-loading">Loading {summary.name}…</div>

  const base = `/app/${summary.slug}`
  const { org } = state

  return (
    <OrgContext.Provider value={{ ...state, base, reload }}>
      <div className="app">
        <aside className="sidebar" aria-label="Main">
          <div className="org-switch">
            <button type="button" className="org-switch-btn" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
              <span className="org-name">{org.name}</span>
              <span className="chip">{state.plans[org.plan].name}</span>
            </button>
            {menuOpen && (
              <div className="org-menu" role="menu">
                {orgs.map((o) => (
                  <button
                    key={o.id}
                    role="menuitem"
                    className={o.id === org.id ? 'current' : ''}
                    onClick={() => {
                      setMenuOpen(false)
                      navigate(`/app/${o.slug}/overview`)
                    }}
                  >
                    {o.name}
                    <span className="label">{o.role}</span>
                  </button>
                ))}
                <button role="menuitem" onClick={() => navigate('/app/new')}>
                  + New organization
                </button>
              </div>
            )}
          </div>

          <nav className="side-nav">
            {NAV.map((item) => (
              <NavLink key={item.to} to={`${base}/${item.to}`}>
                <Icon d={item.icon} />
                {item.label}
              </NavLink>
            ))}
            <a href={`/b/${org.slug}`} target="_blank" rel="noreferrer" className="side-external">
              <Icon d="M11 3h6v6M17 3l-8 8M14 12v5H3V6h5" />
              Public board
            </a>
            {user.is_platform_admin && (
              <NavLink to="/admin">
                <Icon d="M10 2l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V5z" />
                Platform admin
              </NavLink>
            )}
          </nav>

          <div className="side-foot">
            <Link to={`${base}/settings/billing`} className="side-meter">
              <Meter label="Posts this month" used={org.usage.posts.used} limit={org.usage.posts.limit} />
            </Link>
            <div className="side-user">
              <Avatar name={user.name} />
              <div className="side-user-text">
                <span>{user.name}</span>
                <span className="muted">{user.email}</span>
              </div>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={async () => {
                  await signOut()
                  navigate('/')
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>
        <div className={`main${org.is_demo ? ' has-banner' : ''}`}>
          {org.is_demo && (
            <div className="demo-banner">
              This is your private demo organization. It is deleted after 24 hours. <Link to="/signup">Create a real account</Link>
            </div>
          )}
          <Outlet />
        </div>
      </div>
    </OrgContext.Provider>
  )
}

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="topbar">
      <h1>{title}</h1>
      <div className="topbar-actions">{children}</div>
    </header>
  )
}
