import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { agoText, get, post, shortDate, STATUS_LABEL, type Status } from '../api'
import { Avatar, StatusBadge, useToast, VoteBox } from '../components/ui'
import { NotFoundPage, PublicShell, useOrgInfo } from './PublicBoard'

interface Data {
  post: {
    number: number
    title: string
    body: string
    status: Status
    vote_count: number
    comment_count: number
    author_name: string
    created_at: string
    board: { name: string; slug: string }
    voted: boolean
  }
  comments: { author_name: string; body: string; is_team: boolean; created_at: string }[]
  history: { to_status: Status; created_at: string }[]
}

export default function PublicPost() {
  const { orgSlug = '', number = '' } = useParams()
  const navigate = useNavigate()
  const { info, missing } = useOrgInfo(orgSlug)
  const [data, setData] = useState<Data | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [comment, setComment] = useState('')
  const [name, setName] = useState('')
  const [toast, notify] = useToast()

  const load = useCallback(async () => {
    try {
      const d = await get<Data>(`/public/orgs/${orgSlug}/posts/${number}`)
      // A merged duplicate forwards to the post it was merged into.
      if (String(d.post.number) !== number) navigate(`/b/${orgSlug}/p/${d.post.number}`, { replace: true })
      setData(d)
    } catch {
      setNotFound(true)
    }
  }, [orgSlug, number, navigate])

  useEffect(() => {
    load()
  }, [load])

  if (missing || notFound) return <NotFoundPage what="idea" />
  if (!info || !data) return null
  const p = data.post

  const vote = async () => {
    setData({ ...data, post: { ...p, voted: !p.voted, vote_count: p.vote_count + (p.voted ? -1 : 1) } })
    try {
      const res = await post<{ voteCount: number; voted: boolean }>(`/public/orgs/${orgSlug}/posts/${p.number}/vote`)
      setData((d) => (d ? { ...d, post: { ...d.post, voted: res.voted, vote_count: res.voteCount } } : d))
    } catch (err) {
      notify((err as Error).message)
      load()
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await post(`/public/orgs/${orgSlug}/posts/${p.number}/comments`, { body: comment, name: name || undefined })
      setComment('')
      load()
    } catch (err) {
      notify((err as Error).message)
    }
  }

  return (
    <PublicShell org={info.org} boards={info.boards}>
      <Link to={`/b/${orgSlug}/${p.board.slug}`} className="back-link">
        ← Back to {p.board.name}
      </Link>
      <article className="panel post-detail">
        <VoteBox count={p.vote_count} voted={p.voted} onVote={vote} large label={p.voted ? 'Remove your vote' : 'Vote for this idea'} />
        <div className="post-detail-body">
          <h1>{p.title}</h1>
          <div className="public-meta">
            <StatusBadge status={p.status} />
            <span className="label">{p.author_name}</span>
            <span className="label">{shortDate(p.created_at)}</span>
          </div>
          {p.body && <p className="post-text">{p.body}</p>}
        </div>
      </article>

      <section className="panel history">
        <h2 className="label">Status history</h2>
        <ol className="timeline">
          {data.history.map((h, i) => (
            <li key={i} className={i === data.history.length - 1 ? 'current' : ''}>
              <span>{STATUS_LABEL[h.to_status]}</span>
              <span className="label">{shortDate(h.created_at)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel comments">
        <h2 className="label">Comments ({data.comments.length})</h2>
        <ul>
          {data.comments.map((c, i) => (
            <li key={i}>
              <Avatar name={c.author_name} size="sm" forest={c.is_team} />
              <div>
                <div className="thread-head">
                  <strong>{c.author_name}</strong>
                  {c.is_team && <span className="chip chip-team">Team</span>}
                  <span className="label">{agoText(c.created_at)}</span>
                </div>
                <p>{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <form className="comment-form" onSubmit={submit}>
          <textarea className="textarea" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" required maxLength={2000} aria-label="Comment" />
          <div className="suggest-foot">
            <label className="field">
              <span className="label">Your name (optional)</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </label>
            <button className="btn btn-primary">Post comment</button>
          </div>
        </form>
      </section>
      {toast}
    </PublicShell>
  )
}
