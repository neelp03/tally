import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { PageHeader, useOrg } from '../../components/AppShell'

const SECTIONS = [
  { to: 'members', label: 'Members', min: 'member' },
  { to: 'billing', label: 'Billing', min: 'admin' },
  { to: 'api-keys', label: 'API keys', min: 'admin' },
  { to: 'audit-log', label: 'Audit log', min: 'admin' },
  { to: 'security', label: 'Security', min: 'owner' },
] as const

const RANK = { member: 0, admin: 1, owner: 2 }

export default function Settings() {
  const { org, base } = useOrg()
  const { pathname } = useLocation()
  const current = SECTIONS.find((s) => pathname.endsWith(`/settings/${s.to}`))
  const allowed = !current || RANK[org.role] >= RANK[current.min]
  return (
    <>
      <PageHeader title="Settings" />
      <nav className="tabs settings-tabs" aria-label="Settings">
        {SECTIONS.filter((s) => RANK[org.role] >= RANK[s.min]).map((s) => (
          <NavLink key={s.to} to={`${base}/settings/${s.to}`}>
            {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="page settings-page">
        {allowed ? (
          <Outlet />
        ) : (
          <p className="notice">
            {current!.label} is available to {current!.min === 'owner' ? 'the owner' : 'admins and the owner'}. Your role is {org.role}.
          </p>
        )}
      </div>
    </>
  )
}
