import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { dateTime, get } from '../../api'
import { useOrg } from '../../components/AppShell'
import { Avatar } from '../../components/ui'

interface Entry {
  id: number
  created_at: string
  actor_type: 'user' | 'api_key' | 'system'
  actor_label: string
  action: string
  target_label: string | null
  ip: string | null
}

interface AuditResponse {
  entries: Entry[]
  nextBefore: number | null
  facets: { actors: string[]; actions: string[] }
  canExport: boolean
}

export default function AuditLog() {
  const { org, base } = useOrg()
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [days, setDays] = useState('30')
  const [pages, setPages] = useState<(number | null)[]>([null])
  const [data, setData] = useState<AuditResponse | null>(null)

  const filters = new URLSearchParams({ days, ...(actor ? { actor } : {}), ...(action ? { action } : {}) })
  const filterKey = filters.toString()
  const before = pages[pages.length - 1]

  const load = useCallback(async () => {
    const qs = new URLSearchParams(filterKey)
    qs.set('limit', '25')
    if (before) qs.set('before', String(before))
    setData(await get<AuditResponse>(`/orgs/${org.id}/audit-log?${qs}`))
  }, [org.id, filterKey, before])

  useEffect(() => {
    load()
  }, [load])

  const resetPaging = () => setPages([null])

  return (
    <section className="settings-section">
      <div className="settings-head">
        <h2>Audit log</h2>
        <div className="audit-filters">
          <select className="select select-sm" value={actor} onChange={(e) => { setActor(e.target.value); resetPaging() }} aria-label="Person">
            <option value="">All people</option>
            {data?.facets.actors.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select className="select select-sm" value={action} onChange={(e) => { setAction(e.target.value); resetPaging() }} aria-label="Action">
            <option value="">All actions</option>
            {data?.facets.actions.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select className="select select-sm" value={days} onChange={(e) => { setDays(e.target.value); resetPaging() }} aria-label="Period">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
          {data?.canExport ? (
            <a className="btn btn-sm" href={`/api/orgs/${org.id}/audit-log.csv?${filters}`}>
              Export CSV
            </a>
          ) : (
            <Link className="btn btn-sm btn-quiet" to={`${base}/settings/billing`} title="Audit log export needs the Business plan">
              Export CSV (Business)
            </Link>
          )}
        </div>
      </div>

      <table className="table audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th className="num">IP address</th>
          </tr>
        </thead>
        <tbody>
          {data?.entries.map((e) => (
            <tr key={e.id}>
              <td className="mono muted">{dateTime(e.created_at)}</td>
              <td>
                <span className="person">
                  <Avatar name={e.actor_type === 'user' ? e.actor_label : e.actor_type === 'api_key' ? 'A K' : 'S Y'} size="sm" forest={e.actor_type !== 'user'} />
                  {e.actor_label}
                </span>
              </td>
              <td>
                <code className="chip action-chip">{e.action}</code>
              </td>
              <td>{e.target_label}</td>
              <td className="num muted">{e.ip ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.entries.length === 0 && <p className="empty muted">No events match these filters.</p>}

      <div className="pager">
        <button className="btn btn-sm" disabled={pages.length === 1} onClick={() => setPages((p) => p.slice(0, -1))}>
          Newer
        </button>
        <button className="btn btn-sm" disabled={!data?.nextBefore} onClick={() => setPages((p) => [...p, data!.nextBefore])}>
          Older
        </button>
      </div>
    </section>
  )
}
