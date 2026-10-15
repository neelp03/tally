import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { post } from '../api'
import { Corners, Logo, VoteBox } from '../components/ui'
import { useSession } from '../session'

const PLANS = [
  { name: 'Free', price: 0, items: ['1 board', '50 posts / month', '2 seats', 'Public voting'] },
  { name: 'Pro', price: 29, items: ['10 boards', '500 posts / month', '5 seats', 'REST API, 50k calls / month'], recommended: true },
  { name: 'Business', price: 99, items: ['Unlimited boards', '5,000 posts / month', '25 seats', 'Join by email domain (SSO)', 'Audit log export'] },
]

const FEATURES = [
  { tag: 'Public boards', accent: 'forest', title: 'Give customers one place to ask', body: 'Each organization gets public boards for feature requests and bug reports. No account needed to post or vote.' },
  { tag: 'Voting and status', accent: 'gold', title: 'See what matters most', body: 'Votes rank requests. Status changes appear on the board, so customers see when an idea is planned or shipped.' },
  { tag: 'Triage inbox', accent: 'coral', title: 'Sort feedback as a team', body: 'Filter, tag, merge duplicates and leave internal notes. Owners, admins and members each get the access they need.' },
  { tag: 'API', accent: 'mint', title: 'Connect your tools', body: 'Read and write posts with API keys. Every request is rate limited and every change is in the audit log.' },
]

export default function Landing() {
  const { user, orgs, config } = useSession()
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)

  const startDemo = async () => {
    setStarting(true)
    try {
      const { org } = await post<{ org: { slug: string } }>('/demo')
      window.location.assign(`/app/${org.slug}/inbox`)
    } catch {
      setStarting(false)
      navigate('/signup')
    }
  }

  return (
    <div className="landing">
      <header className="site-nav">
        <Logo />
        <nav className="site-links label">
          <a href="#product">01. Product</a>
          <a href="#pricing">02. Pricing</a>
          <a href="https://github.com/neelp03/tally#rest-api">03. API</a>
        </nav>
        <div className="site-actions">
          {user ? (
            <Link className="btn btn-primary" to={orgs[0] ? `/app/${orgs[0].slug}/overview` : '/app'}>
              Open app
            </Link>
          ) : (
            <>
              <Link className="btn btn-ghost" to="/signin">
                Sign in
              </Link>
              <Link className="btn btn-primary" to="/signup">
                Start free
              </Link>
            </>
          )}
        </div>
      </header>

      <section className="hero mosaic">
        <div className="hero-inner">
          <div className="hero-copy">
            <h1>Know what your customers want next.</h1>
            <p className="hero-sub label">Public feedback boards, voting and triage for B2B teams</p>
            <div className="hero-cta">
              {config.demo && (
                <button className="btn btn-primary" onClick={startDemo} disabled={starting}>
                  {starting ? 'Preparing your demo…' : 'Try the live demo'}
                </button>
              )}
              <Link className="btn" to="/signup">
                Create an organization
              </Link>
            </div>
            {config.demo && <p className="muted hero-note">The demo creates a private organization with sample data. No sign-up needed.</p>}
          </div>
          <div className="hero-mock panel" aria-hidden>
            {[
              ['Export dashboards to PDF', 142, true, 'planned'],
              ['SSO with Okta', 98, false, 'in_progress'],
              ['Dark mode for embedded charts', 75, false, 'open'],
            ].map(([title, votes, voted, status]) => (
              <div className="hero-mock-row" key={String(title)}>
                <VoteBox count={Number(votes)} voted={Boolean(voted)} />
                <div>
                  <span>{title}</span>
                  <span className={`status status-${status}`}>{String(status).replace('_', ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="product" className="features">
        <div className="bento feature-grid">
          {FEATURES.map((f, i) => (
            <div key={f.tag} className={`feature accent-${f.accent}`}>
              <span className="label">
                0{i + 1}. {f.tag}
              </span>
              <h2>{f.title}</h2>
              <p className="muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="pricing">
        <h2 className="section-title">Pricing</h2>
        <p className="muted">Every plan isolates your data from every other organization. Change plans at any time.</p>
        <div className="bento plan-grid">
          {PLANS.map((p) => (
            <div key={p.name} className={`plan-card${p.recommended ? ' corners current' : ''}`}>
              {p.recommended && <Corners />}
              <div className="plan-card-head">
                <h3>{p.name}</h3>
                {p.recommended && <span className="chip">Recommended</span>}
              </div>
              <p className="price">
                <span className="mono">${p.price}</span> <span className="muted">/ month</span>
              </p>
              <ul className="checks">
                {p.items.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <Link className={`btn btn-block${p.recommended ? ' btn-primary' : ''}`} to="/signup">
                {p.price === 0 ? 'Start free' : `Start with ${p.name}`}
              </Link>
            </div>
          ))}
        </div>
      </section>

      <footer className="site-foot">
        <Logo />
        <span className="label">Multi-tenant SaaS demo: PostgreSQL row-level security, Stripe billing, RBAC</span>
        <a className="label" href="https://github.com/neelp03/tally">
          Source
        </a>
      </footer>
    </div>
  )
}
