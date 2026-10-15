import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { agoText, fmt, get, STATUS_LABEL, type Status, type Usage } from '../api'
import { PageHeader, useOrg } from '../components/AppShell'
import { Meter, StatusBadge, VoteBox } from '../components/ui'

interface OverviewData {
  stats: { openPosts: number; newThisWeek: number; newLastWeek: number; votesThisWeek: number; votesLastWeek: number; shippedThisMonth: number }
  top: { id: string; number: number; title: string; status: Status; vote_count: number }[]
  activity: { kind: 'post' | 'status' | 'comment'; at: string; who: string; title: string; number: number; detail: string | null }[]
  usage: Usage
}

function Delta({ now, before }: { now: number; before: number }) {
  if (before === 0) return null
  const pct = Math.round(((now - before) / before) * 100)
  if (pct === 0) return <span className="delta muted">0%</span>
  return <span className={`delta ${pct > 0 ? 'up' : 'down'}`}>{pct > 0 ? `+${pct}%` : `${pct}%`}</span>
}

export default function Overview() {
  const { org, base } = useOrg()
  const [data, setData] = useState<OverviewData | null>(null)

  useEffect(() => {
    get<OverviewData>(`/orgs/${org.id}/overview`).then(setData)
  }, [org.id])

  return (
    <>
      <PageHeader title="Overview">
        <a className="btn btn-primary" href={`/b/${org.slug}`} target="_blank" rel="noreferrer">
          Open public board
        </a>
      </PageHeader>
      {data && (
        <div className="page">
          <div className="bento stats">
            <div className="stat">
              <span className="label">Open posts</span>
              <strong>{fmt(data.stats.openPosts)}</strong>
            </div>
            <div className="stat">
              <span className="label">New this week</span>
              <strong>{fmt(data.stats.newThisWeek)}</strong>
              <Delta now={data.stats.newThisWeek} before={data.stats.newLastWeek} />
            </div>
            <div className="stat">
              <span className="label">Votes this week</span>
              <strong>{fmt(data.stats.votesThisWeek)}</strong>
              <Delta now={data.stats.votesThisWeek} before={data.stats.votesLastWeek} />
            </div>
            <div className="stat">
              <span className="label">Shipped this month</span>
              <strong>{fmt(data.stats.shippedThisMonth)}</strong>
            </div>
          </div>

          <div className="two-col">
            <section className="panel">
              <div className="panel-head">
                <h2>Top requests</h2>
                <Link to={`${base}/inbox`} className="label">
                  View inbox
                </Link>
              </div>
              {data.top.length === 0 ? (
                <p className="empty muted">No open requests yet. Share your public board to start collecting feedback.</p>
              ) : (
                <ul className="top-list">
                  {data.top.map((p) => (
                    <li key={p.id}>
                      <VoteBox count={p.vote_count} />
                      <div>
                        <Link to={`${base}/inbox?post=${p.id}`} className="row-title">
                          {p.title}
                        </Link>
                        <StatusBadge status={p.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Recent activity</h2>
              </div>
              <ol className="activity">
                {data.activity.map((a, i) => (
                  <li key={i} className={`activity-${a.kind}`}>
                    <p>
                      <strong>{a.who}</strong>{' '}
                      {a.kind === 'post' && <>posted </>}
                      {a.kind === 'status' && <>moved </>}
                      {a.kind === 'comment' && <>commented on </>}
                      <span className="activity-title">{a.title}</span>
                      {a.kind === 'status' && a.detail && <> to {STATUS_LABEL[a.detail as Status]}</>}
                    </p>
                    {a.kind === 'comment' && a.detail && <blockquote>{a.detail}</blockquote>}
                    <span className="label">{agoText(a.at)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>Plan usage</h2>
              <Link to={`${base}/settings/billing`} className="label">
                Manage billing
              </Link>
            </div>
            <div className="bento usage-grid">
              <div>
                <Meter label="Posts" used={data.usage.posts.used} limit={data.usage.posts.limit} />
              </div>
              <div>
                <Meter label="Boards" used={data.usage.boards.used} limit={data.usage.boards.limit} />
              </div>
              <div>
                <Meter label="Seats" used={data.usage.seats.used} limit={data.usage.seats.limit} />
              </div>
              <div>
                <Meter label="API calls" used={data.usage.apiCalls.used} limit={data.usage.apiCalls.limit} />
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
