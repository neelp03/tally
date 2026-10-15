import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom'
import { agoText, ApiError, get, post, STATUS_LABEL, STATUSES, type Status } from '../api'
import { StatusBadge, useToast, VoteBox } from '../components/ui'

interface PublicPost {
  number: number
  title: string
  excerpt: string
  status: Status
  vote_count: number
  comment_count: number
  created_at: string
  voted: boolean
}

interface OrgInfo {
  org: { name: string; slug: string }
  boards: { name: string; slug: string }[]
}

export function PublicShell({ org, boards, children }: { org: OrgInfo['org']; boards: OrgInfo['boards']; children: React.ReactNode }) {
  return (
    <div className="public">
      <header className="public-head">
        <Link to={`/b/${org.slug}`} className="public-org">
          <span className="org-mark">{org.name[0]}</span>
          {org.name}
        </Link>
        <nav className="tabs" aria-label="Boards">
          {boards.map((b) => (
            <NavLink key={b.slug} to={`/b/${org.slug}/${b.slug}`}>
              {b.name}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="public-foot label">
        Powered by <Link to="/">Tally</Link>
      </footer>
    </div>
  )
}

export function useOrgInfo(slug: string) {
  const [info, setInfo] = useState<OrgInfo | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    get<OrgInfo>(`/public/orgs/${slug}`)
      .then(setInfo)
      .catch(() => setMissing(true))
  }, [slug])
  return { info, missing }
}

export function NotFoundPage({ what = 'page' }: { what?: string }) {
  return (
    <div className="center-page mosaic">
      <div className="panel panel-body stack" style={{ maxWidth: 420 }}>
        <h1>Not found</h1>
        <p className="muted">This {what} doesn't exist, or it isn't public.</p>
        <Link className="btn" to="/">
          Go to Tally
        </Link>
      </div>
    </div>
  )
}

export default function PublicBoard() {
  const { orgSlug = '', boardSlug } = useParams()
  const navigate = useNavigate()
  const { info, missing } = useOrgInfo(orgSlug)
  const [posts, setPosts] = useState<PublicPost[] | null>(null)
  const [sort, setSort] = useState<'trending' | 'top' | 'new'>('trending')
  const [status, setStatus] = useState<Status | ''>('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [toast, notify] = useToast()
  const board = boardSlug ?? info?.boards[0]?.slug

  const load = useCallback(async () => {
    if (!board) return
    const qs = new URLSearchParams({ sort, ...(status ? { status } : {}) })
    setPosts((await get<{ posts: PublicPost[] }>(`/public/orgs/${orgSlug}/boards/${board}/posts?${qs}`)).posts)
  }, [orgSlug, board, sort, status])

  useEffect(() => {
    load().catch(() => setPosts([]))
  }, [load])

  if (missing) return <NotFoundPage what="board" />
  if (!info) return null
  if (!boardSlug && board) return <Navigate to={`/b/${orgSlug}/${board}`} replace />

  const vote = async (p: PublicPost) => {
    // Optimistic toggle, corrected by the server's count.
    setPosts((list) => list?.map((x) => (x.number === p.number ? { ...x, voted: !x.voted, vote_count: x.vote_count + (x.voted ? -1 : 1) } : x)) ?? null)
    try {
      const res = await post<{ voteCount: number; voted: boolean }>(`/public/orgs/${orgSlug}/posts/${p.number}/vote`)
      setPosts((list) => list?.map((x) => (x.number === p.number ? { ...x, voted: res.voted, vote_count: res.voteCount } : x)) ?? null)
    } catch (err) {
      notify((err as Error).message)
      load()
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const res = await post<{ post: { number: number } }>(`/public/orgs/${orgSlug}/boards/${board}/posts`, { title, body, name: name || undefined })
      setTitle('')
      setBody('')
      notify('Thanks! Your idea is posted, with your vote.')
      navigate(`/b/${orgSlug}/p/${res.post.number}`)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'usage_limit' ? 'This board is not taking new ideas right now. Try again later.' : (err as Error).message)
    }
  }

  return (
    <PublicShell org={info.org} boards={info.boards}>
      <form className="panel suggest" onSubmit={submit}>
        <h2>Suggest an idea</h2>
        <label className="field">
          <span className="label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short, descriptive title" required minLength={3} maxLength={140} />
        </label>
        <label className="field">
          <span className="label">Details</span>
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="What's the problem? What would a good solution look like?" maxLength={5000} />
        </label>
        <div className="suggest-foot">
          <label className="field">
            <span className="label">Your name (optional)</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <button className="btn btn-primary">Submit idea</button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>

      <div className="public-toolbar">
        <div className="segmented" role="group" aria-label="Sort">
          {(['trending', 'top', 'new'] as const).map((s) => (
            <button key={s} aria-pressed={sort === s} onClick={() => setSort(s)}>
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value as Status | '')} aria-label="Status">
          <option value="">Status: All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <ul className="panel public-list">
        {posts?.length === 0 && <li className="empty muted">No ideas here yet. Be the first to suggest one.</li>}
        {posts?.map((p) => (
          <li key={p.number}>
            <VoteBox count={p.vote_count} voted={p.voted} onVote={() => vote(p)} large label={`${p.voted ? 'Remove your vote for' : 'Vote for'} ${p.title}`} />
            <div className="public-post">
              <Link to={`/b/${orgSlug}/p/${p.number}`} className="row-title">
                {p.title}
              </Link>
              {p.excerpt && <p className="muted clamp-2">{p.excerpt}</p>}
              <div className="public-meta">
                <StatusBadge status={p.status} />
                <span className="label">
                  {p.comment_count} {p.comment_count === 1 ? 'comment' : 'comments'}
                </span>
                <span className="label">{agoText(p.created_at)}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {toast}
    </PublicShell>
  )
}
