import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ago, get, patch, post as apiPost, STATUS_LABEL, STATUSES, type Board, type Comment, type Post, type Status } from '../api'
import { PageHeader, useOrg } from '../components/AppShell'
import { Avatar, Dialog, StatusBadge, Tag, useToast, VoteBox } from '../components/ui'

interface ListResponse {
  posts: Post[]
  total: number
  statusCounts: Partial<Record<Status, number>>
}

interface Detail {
  post: Post
  comments: Comment[]
  voters: { name: string }[]
  history: { from_status: Status | null; to_status: Status; created_at: string; changed_by: string | null }[]
}

export default function Inbox() {
  const { org, reload: reloadOrg } = useOrg()
  const [params, setParams] = useSearchParams()
  const [boards, setBoards] = useState<Board[]>([])
  const [list, setList] = useState<ListResponse | null>(null)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [creating, setCreating] = useState(false)
  const [toast, showToast] = useToast()

  const status = (params.get('status') as Status | null) ?? null
  const board = params.get('board') ?? ''
  const sort = params.get('sort') ?? 'votes'
  const selectedId = params.get('post')

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ sort, limit: '100' })
    if (status) qs.set('status', status)
    if (board) qs.set('board', board)
    if (params.get('q')) qs.set('q', params.get('q')!)
    setList(await get<ListResponse>(`/orgs/${org.id}/posts?${qs}`))
  }, [org.id, status, board, sort, params])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    get<{ boards: Board[] }>(`/orgs/${org.id}/boards`).then((r) => setBoards(r.boards))
  }, [org.id])

  // Debounced search into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('q') ?? '') !== query) setParam('q', query || null)
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const total = useMemo(() => Object.values(list?.statusCounts ?? {}).reduce((a, b) => a + (b ?? 0), 0), [list])

  return (
    <>
      <PageHeader title="Inbox">
        <label className="search">
          <span className="sr-only">Search posts</span>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <input className="input" placeholder="Search posts…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + New post
        </button>
      </PageHeader>

      <div className={`inbox${selectedId ? ' with-detail' : ''}`}>
        <div className="inbox-list">
          <div className="filters">
            <div className="segmented" role="group" aria-label="Status">
              <button aria-pressed={!status} onClick={() => setParam('status', null)}>
                All<span className="count">{total}</span>
              </button>
              {STATUSES.filter((s) => s !== 'closed').map((s) => (
                <button key={s} aria-pressed={status === s} onClick={() => setParam('status', s)}>
                  {STATUS_LABEL[s]}
                  <span className="count">{list?.statusCounts[s] ?? 0}</span>
                </button>
              ))}
            </div>
            <select className="select select-sm" value={board} onChange={(e) => setParam('board', e.target.value || null)} aria-label="Board">
              <option value="">All boards</option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={sort} onChange={(e) => setParam('sort', e.target.value)} aria-label="Sort">
              <option value="votes">Most votes</option>
              <option value="new">Newest</option>
            </select>
          </div>

          {list && list.posts.length === 0 && (
            <div className="empty">
              <strong>No posts match.</strong>
              <span className="muted">Change the filters, or share your public board to collect feedback.</span>
            </div>
          )}

          {list && list.posts.length > 0 && (
            <table className="table inbox-table">
              <thead>
                <tr>
                  <th style={{ width: 64 }}>Votes</th>
                  <th>Title</th>
                  <th className="col-board">Board</th>
                  <th>Status</th>
                  <th className="col-tags">Tags</th>
                  <th className="col-author">Author</th>
                  <th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {list.posts.map((p) => (
                  <tr
                    key={p.id}
                    className={p.id === selectedId ? 'selected' : ''}
                    onClick={() => setParam('post', p.id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setParam('post', p.id)
                    }}
                    aria-selected={p.id === selectedId}
                  >
                    <td>
                      <VoteBox count={p.vote_count} />
                    </td>
                    <td className="cell-title">
                      <span className="row-title">{p.title}</span>
                      <span className="row-excerpt">{p.body}</span>
                    </td>
                    <td className="col-board">{p.board_name}</td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="col-tags">
                      <span className="tag-cell">
                        {p.tags[0] && <Tag name={p.tags[0]} />}
                        {p.tags.length > 1 && <span className="chip">+{p.tags.length - 1}</span>}
                      </span>
                    </td>
                    <td className="col-author">
                      <Avatar name={p.author_name} size="sm" />
                    </td>
                    <td className="num muted">{ago(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedId && (
          <PostPanel
            key={selectedId}
            postId={selectedId}
            onClose={() => setParam('post', null)}
            onChanged={load}
            posts={list?.posts ?? []}
            notify={showToast}
          />
        )}
      </div>

      {creating && (
        <NewPostDialog
          boards={boards}
          onClose={() => setCreating(false)}
          onCreated={async (p) => {
            setCreating(false)
            await Promise.all([load(), reloadOrg()])
            setParam('post', p.id)
          }}
        />
      )}
      {toast}
    </>
  )
}

function PostPanel({
  postId,
  posts,
  onClose,
  onChanged,
  notify,
}: {
  postId: string
  posts: Post[]
  onClose(): void
  onChanged(): void
  notify(msg: string): void
}) {
  const { org } = useOrg()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(true)
  const [tagInput, setTagInput] = useState('')
  const [merging, setMerging] = useState(false)

  const load = useCallback(async () => {
    try {
      setDetail(await get<Detail>(`/orgs/${org.id}/posts/${postId}`))
    } catch (err) {
      setError((err as Error).message)
    }
  }, [org.id, postId])

  useEffect(() => {
    load()
  }, [load])

  if (error) {
    return (
      <aside className="detail" aria-label="Post detail">
        <div className="detail-head">
          <p className="form-error">{error}</p>
          <button className="btn btn-quiet btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </aside>
    )
  }
  if (!detail) return <aside className="detail" aria-busy="true" />

  const p = detail.post
  const named = detail.voters.filter((v) => v.name !== 'Anonymous')

  // Optimistic: show the change immediately, roll back if the server refuses.
  const update = async (changes: Partial<Pick<Post, 'status' | 'tags'>>) => {
    const before = detail
    setDetail({ ...detail, post: { ...p, ...changes } })
    try {
      const { post: saved } = await patch<{ post: Post }>(`/orgs/${org.id}/posts/${p.id}`, changes)
      setDetail((d) => (d ? { ...d, post: saved } : d))
      onChanged()
    } catch (err) {
      setDetail(before)
      notify((err as Error).message)
    }
  }

  const addTag = (e: FormEvent) => {
    e.preventDefault()
    const tag = tagInput.trim().toLowerCase()
    setTagInput('')
    if (tag && !p.tags.includes(tag)) update({ tags: [...p.tags, tag] })
  }

  const sendReply = async (e: FormEvent) => {
    e.preventDefault()
    if (!reply.trim()) return
    try {
      await apiPost(`/orgs/${org.id}/posts/${p.id}/comments`, { body: reply, internal })
      setReply('')
      await load()
      onChanged()
    } catch (err) {
      notify((err as Error).message)
    }
  }

  return (
    <aside className="detail" aria-label="Post detail">
      <div className="detail-head">
        <div className="detail-title">
          <span className="label">#{p.number}</span>
          <h2>{p.title}</h2>
        </div>
        <button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </div>

      <div className="detail-meta">
        <label className="status-select">
          <span className="sr-only">Status</span>
          <select className={`select select-sm status-${p.status}`} value={p.status} onChange={(e) => update({ status: e.target.value as Status })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          Board: <strong className="ink">{p.board_name}</strong>
        </span>
      </div>

      <div className="detail-tags">
        {p.tags.map((t) => (
          <button key={t} className="tag-remove" onClick={() => update({ tags: p.tags.filter((x) => x !== t) })} title={`Remove ${t}`}>
            <Tag name={t} />
          </button>
        ))}
        <form onSubmit={addTag}>
          <input className="input tag-input" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="+ tag" aria-label="Add tag" maxLength={30} />
        </form>
      </div>

      <div className="detail-scroll">
        <section>
          <div className="section-label">
            <span className="label">Voters ({p.vote_count})</span>
          </div>
          <div className="voters">
            {named.slice(0, 5).map((v, i) => (
              <Avatar key={i} name={v.name} size="sm" />
            ))}
            {p.vote_count > Math.min(5, named.length) && (
              <span className="label">
                {named.length ? '+' : ''}
                {p.vote_count - Math.min(5, named.length)} {named.length ? 'more' : 'anonymous'}
              </span>
            )}
            {p.vote_count === 0 && <span className="muted">No votes yet.</span>}
          </div>
        </section>

        <section>
          <span className="label">Description</span>
          <p className="detail-body">{p.body || <span className="muted">No description.</span>}</p>
        </section>

        <button className="btn btn-block" onClick={() => setMerging(true)}>
          Merge into another post…
        </button>

        <section>
          <span className="label">Activity</span>
          <ol className="thread">
            {detail.history
              .filter((h) => h.from_status)
              .map((h, i) => (
                <li key={`h${i}`} className="thread-event">
                  <span className="muted">
                    {h.changed_by ?? 'API'} moved this to <StatusBadge status={h.to_status} />
                  </span>
                  <span className="label">{ago(h.created_at)}</span>
                </li>
              ))}
            {detail.comments.map((c) => (
              <li key={c.id} className={`thread-comment${c.is_internal ? ' internal' : ''}`}>
                <div className="thread-head">
                  <strong>{c.author_name}</strong>
                  {c.is_internal && <span className="chip chip-internal">Internal</span>}
                  {!c.is_internal && c.is_team && <span className="chip chip-team">Team</span>}
                  <span className="label">{ago(c.created_at)}</span>
                </div>
                <p>{c.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <form className="reply" onSubmit={sendReply}>
        <textarea className="textarea" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" aria-label="Reply" rows={3} />
        <div className="reply-foot">
          <div className="segmented" role="group" aria-label="Reply type">
            <button type="button" aria-pressed={internal} onClick={() => setInternal(true)}>
              Internal note
            </button>
            <button type="button" aria-pressed={!internal} onClick={() => setInternal(false)}>
              Public reply
            </button>
          </div>
          <button className="btn btn-primary btn-sm" disabled={!reply.trim()}>
            Post
          </button>
        </div>
      </form>

      {merging && (
        <MergeDialog
          from={p}
          candidates={posts.filter((x) => x.id !== p.id)}
          onClose={() => setMerging(false)}
          onMerged={(intoId) => {
            setMerging(false)
            notify(`Merged into #${posts.find((x) => x.id === intoId)?.number}.`)
            onChanged()
            onClose()
          }}
        />
      )}
    </aside>
  )
}

function MergeDialog({ from, candidates, onClose, onMerged }: { from: Post; candidates: Post[]; onClose(): void; onMerged(id: string): void }) {
  const { org } = useOrg()
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      title="Merge post"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!target}
            onClick={async () => {
              try {
                await apiPost(`/orgs/${org.id}/posts/${from.id}/merge`, { intoId: target })
                onMerged(target)
              } catch (err) {
                setError((err as Error).message)
              }
            }}
          >
            Merge
          </button>
        </>
      }
    >
      <p>
        Votes and comments from <strong>{from.title}</strong> move to the post you select. Voters are counted once. The duplicate is closed and its
        public link forwards to the target.
      </p>
      <label className="field">
        <span className="label">Merge into</span>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Select a post</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.number} {c.title} ({c.vote_count} votes)
            </option>
          ))}
        </select>
      </label>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  )
}

function NewPostDialog({ boards, onClose, onCreated }: { boards: Board[]; onClose(): void; onCreated(p: Post): void }) {
  const { org } = useOrg()
  const [boardId, setBoardId] = useState(boards[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      const { post } = await apiPost<{ post: Post }>(`/orgs/${org.id}/posts`, { boardId, title, body })
      onCreated(post)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Dialog title="New post" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span className="label">Board</span>
          <select className="select" value={boardId} onChange={(e) => setBoardId(e.target.value)}>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={140} autoFocus />
        </label>
        <label className="field">
          <span className="label">Description</span>
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={title.trim().length < 3}>
            Create post
          </button>
        </div>
      </form>
    </Dialog>
  )
}

