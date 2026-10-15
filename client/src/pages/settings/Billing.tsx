import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fmt, get, post, shortDate, type Plan, type PlanLimits, type Usage } from '../../api'
import { useOrg } from '../../components/AppShell'
import { Corners, Meter } from '../../components/ui'

interface BillingData {
  mode: 'stripe' | 'demo'
  plan: Plan
  status: string | null
  currentPeriodEnd: string | null
  hasCustomer: boolean
  usage: Usage
  plans: Record<Plan, PlanLimits>
  invoices: { id: string; number: string | null; date: string; amount: number; currency: string; status: string | null; pdfUrl: string | null }[]
}

const ORDER: Plan[] = ['free', 'pro', 'business']

function features(p: PlanLimits): string[] {
  return [
    p.boards === null ? 'Unlimited boards' : `${p.boards} board${p.boards === 1 ? '' : 's'}`,
    `${fmt(p.postsPerMonth)} posts / month`,
    `${p.seats} seats`,
    p.apiCallsPerMonth ? `${fmt(p.apiCallsPerMonth)} API calls / month` : 'No API access',
    ...(p.ssoDomain ? ['Join by email domain (SSO)'] : []),
    ...(p.auditExport ? ['Audit log export'] : []),
  ]
}

export default function Billing() {
  const { org, reload } = useOrg()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<BillingData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isOwner = org.role === 'owner'
  const checkout = params.get('checkout')

  const load = useCallback(async () => {
    setData(await get<BillingData>(`/orgs/${org.id}/billing`))
  }, [org.id])

  useEffect(() => {
    load()
    if (checkout === 'success') reload()
  }, [load, checkout, reload])

  if (!data) return null

  const go = async (key: string, action: () => Promise<{ url: string | null }>) => {
    setBusy(key)
    setError(null)
    try {
      const { url } = await action()
      if (url) window.location.assign(url)
      else {
        await Promise.all([load(), reload()])
        setBusy(null)
      }
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  const current = data.plans[data.plan]

  return (
    <section className="settings-section">
      {checkout === 'success' && (
        <p className="notice notice-ok">
          Your plan is updated. <button className="btn btn-quiet btn-sm" onClick={() => setParams({})}>Dismiss</button>
        </p>
      )}
      {checkout === 'canceled' && <p className="notice">Checkout was canceled. Your plan did not change.</p>}
      {data.mode === 'demo' && (
        <p className="notice notice-warn">
          Demo billing: no Stripe account is connected, so plan changes are simulated and nothing is charged. With Stripe keys set, the same buttons open
          Stripe Checkout and the billing portal.
        </p>
      )}
      {error && <p className="notice notice-error">{error}</p>}

      <h2>Current plan</h2>
      <div className="panel current-plan">
        <div>
          <p className="plan-line">
            <strong>{current.name}</strong>
            <span className="chip">${current.priceMonthly} / month</span>
            {data.status && data.status !== 'active' && <span className="chip chip-internal">{data.status.replace('_', ' ')}</span>}
          </p>
          <p className="label">
            {data.currentPeriodEnd && data.plan !== 'free' ? `Renews ${shortDate(data.currentPeriodEnd)}` : 'No active subscription'}
          </p>
        </div>
        {isOwner && data.mode === 'stripe' && data.hasCustomer && (
          <button className="btn" disabled={busy !== null} onClick={() => go('portal', () => post(`/orgs/${org.id}/billing/portal`))}>
            Manage payment method
          </button>
        )}
        {isOwner && data.mode === 'demo' && data.plan !== 'free' && (
          <button className="btn btn-danger" disabled={busy !== null} onClick={() => go('cancel', async () => {
              await post(`/orgs/${org.id}/billing/demo-cancel`)
              return { url: null }
            })}>
            Cancel plan
          </button>
        )}
      </div>

      <h2>Usage this billing period</h2>
      <div className="panel usage-list">
        <Meter label="Posts" used={data.usage.posts.used} limit={data.usage.posts.limit} />
        <Meter label="Boards" used={data.usage.boards.used} limit={data.usage.boards.limit} />
        <Meter label="Seats" used={data.usage.seats.used} limit={data.usage.seats.limit} />
        <Meter label="API calls" used={data.usage.apiCalls.used} limit={data.usage.apiCalls.limit} />
      </div>

      <h2>Plans</h2>
      <div className="bento plan-grid">
        {ORDER.map((key) => {
          const p = data.plans[key]
          const isCurrent = key === data.plan
          return (
            <div key={key} className={`plan-card${isCurrent ? ' corners current' : ''}`}>
              {isCurrent && <Corners />}
              <div className="plan-card-head">
                <h3>{p.name}</h3>
                {isCurrent && <span className="chip">Current</span>}
              </div>
              <p className="price">
                <span className="mono">${p.priceMonthly}</span> <span className="muted">/ month</span>
              </p>
              <ul className="checks">
                {features(p).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {!isCurrent && key !== 'free' && isOwner && (
                <button
                  className={`btn btn-block ${ORDER.indexOf(key) > ORDER.indexOf(data.plan) ? 'btn-primary' : ''}`}
                  disabled={busy !== null}
                  onClick={() => go(key, () => post(`/orgs/${org.id}/billing/checkout`, { plan: key }))}
                >
                  {busy === key ? 'Opening checkout…' : ORDER.indexOf(key) > ORDER.indexOf(data.plan) ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {!isOwner && <p className="muted">Only the owner can change the plan.</p>}

      <h2>Invoices</h2>
      {data.invoices.length === 0 ? (
        <p className="muted">{data.mode === 'demo' ? 'Demo billing creates no invoices.' : 'No invoices yet.'}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Invoice</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((i) => (
              <tr key={i.id}>
                <td className="mono">{shortDate(i.date)}</td>
                <td className="mono muted">{i.number}</td>
                <td className="num">
                  {(i.amount / 100).toLocaleString('en-US', { style: 'currency', currency: i.currency.toUpperCase() })}
                </td>
                <td>{i.status && <span className={`chip${i.status === 'paid' ? '' : ' chip-internal'}`}>{i.status}</span>}</td>
                <td className="cell-actions">
                  {i.pdfUrl && (
                    <a href={i.pdfUrl} target="_blank" rel="noreferrer">
                      PDF
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
