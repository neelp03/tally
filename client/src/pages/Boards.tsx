import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { del, get, patch, post, type Board } from '../api'
import { PageHeader, useOrg } from '../components/AppShell'
import { Corners, CopyButton, Dialog, useToast } from '../components/ui'

export default function Boards() {
  const { org, base, reload } = useOrg()
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [editing, setEditing] = useState<Board | 'new' | null>(null)
  const [toast, notify] = useToast()
  const canManage = org.role !== 'member'
  const limit = org.limits.boards
  const atLimit = limit !== null && (boards?.length ?? 0) >= limit

  const load = useCallback(async () => {
    setBoards((await get<{ boards: Board[] }>(`/orgs/${org.id}/boards`)).boards)
  }, [org.id])

  useEffect(() => {
    load()
  }, [load])

  const publicUrl = (b: Board) => `${location.origin}/b/${org.slug}/${b.slug}`

  return (
    <>
      <PageHeader title="Boards">
        {canManage && (
          <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={atLimit}>
            + New board
          </button>
        )}
      </PageHeader>
      <div className="page">
        <p className="label">
          Boards {boards?.length ?? 0} / {limit ?? '∞'} on {org.limits.name}
          {atLimit && canManage && (
            <>
              {' '}
              <Link to={`${base}/settings/billing`}>Upgrade for more</Link>
            </>
          )}
        </p>
        {boards && (
          <div className="bento board-grid">
            {boards.map((b) => (
              <article key={b.id} className="board-cell">
                <div className="board-cell-head">
                  <h2>{b.name}</h2>
                  <span className={`chip${b.is_public ? '' : ' chip-internal'}`}>{b.is_public ? 'Public' : 'Private'}</span>
                </div>
                <p className="muted">
                  <span className="mono">{b.post_count}</span> {b.post_count === 1 ? 'post' : 'posts'}
                </p>
                {b.is_public ? (
                  <div className="board-link">
                    <a className="mono" href={`/b/${org.slug}/${b.slug}`} target="_blank" rel="noreferrer">
                      /b/{org.slug}/{b.slug}
                    </a>
                    <CopyButton text={publicUrl(b)} label="Copy link" />
                  </div>
                ) : (
                  <p className="muted">Only your team can see this board.</p>
                )}
                {canManage && (
                  <div className="board-actions">
                    <button className="btn btn-sm" onClick={() => setEditing(b)}>
                      Edit
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={async () => {
                        if (!confirm(`Delete "${b.name}" and all of its posts? This cannot be undone.`)) return
                        try {
                          await del(`/orgs/${org.id}/boards/${b.id}`)
                          await Promise.all([load(), reload()])
                        } catch (err) {
                          notify((err as Error).message)
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </article>
            ))}
            {canManage && !atLimit && (
              <button className="board-cell board-new corners" onClick={() => setEditing('new')}>
                <Corners />
                <span>+ New board</span>
                <span className="muted">Collect feature requests, bugs or ideas in separate lists.</span>
              </button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <BoardDialog
          board={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await Promise.all([load(), reload()])
          }}
        />
      )}
      {toast}
    </>
  )
}

function BoardDialog({ board, onClose, onSaved }: { board: Board | null; onClose(): void; onSaved(): void }) {
  const { org } = useOrg()
  const [name, setName] = useState(board?.name ?? '')
  const [isPublic, setIsPublic] = useState(board?.is_public ?? true)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      if (board) await patch(`/orgs/${org.id}/boards/${board.id}`, { name, isPublic })
      else await post(`/orgs/${org.id}/boards`, { name, isPublic })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Dialog title={board ? 'Edit board' : 'New board'} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
        </label>
        <label className="check">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          Public: anyone with the link can view, post and vote
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">{board ? 'Save board' : 'Create board'}</button>
        </div>
      </form>
    </Dialog>
  )
}
