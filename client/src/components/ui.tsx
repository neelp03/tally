import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { fmt, initials, STATUS_LABEL, type Status } from '../api'

export function Logo({ to = '/', size = 30 }: { to?: string; size?: number }) {
  return (
    <Link to={to} className="logo" aria-label="Tally home">
      <span className="logo-mark" style={{ width: size, height: size }}>
        <svg viewBox="0 0 32 32" width={size * 0.6} height={size * 0.6} aria-hidden>
          <path d="M6 8h20M16 8v18" stroke="#fff" strokeWidth="3.5" strokeLinecap="square" />
        </svg>
      </span>
      Tally
    </Link>
  )
}

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
}

export function Tag({ name }: { name: string }) {
  return <span className={`chip${name === 'bug' ? ' chip-bug' : ''}`}>{name}</span>
}

const Chevron = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden>
    <path d="M1 5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

export function VoteBox({
  count,
  voted = false,
  onVote,
  large = false,
  label,
}: {
  count: number
  voted?: boolean
  onVote?: () => void
  large?: boolean
  label?: string
}) {
  const cls = `vote${voted ? ' voted' : ''}${large ? ' vote-lg' : ''}`
  if (!onVote) {
    return (
      <span className={cls} aria-label={`${count} votes`}>
        <Chevron />
        {fmt(count)}
      </span>
    )
  }
  return (
    <button type="button" className={cls} onClick={onVote} aria-pressed={voted} aria-label={label ?? `${voted ? 'Remove vote' : 'Vote'} (${count})`}>
      <Chevron />
      {fmt(count)}
    </button>
  )
}

export function Avatar({ name, size = 'md', forest = false }: { name: string; size?: 'sm' | 'md'; forest?: boolean }) {
  return (
    <span className={`avatar${size === 'sm' ? ' avatar-sm' : ''}${forest ? ' avatar-forest' : ''}`} title={name} aria-hidden>
      {initials(name)}
    </span>
  )
}

export function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const ratio = limit ? used / limit : 0
  const state = limit === null ? '' : ratio >= 1 ? ' over' : ratio >= 0.8 ? ' near' : ''
  return (
    <div className={`meter${state}`}>
      <div className="meter-head">
        <span className="muted">{label}</span>
        <span className="value">
          {fmt(used)} / {limit === null ? '∞' : limit === 0 ? '—' : fmt(limit)}
        </span>
      </div>
      <div
        className="meter-bar"
        role="meter"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
      >
        <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
    </div>
  )
}

/** A native <dialog> opened as a modal; closing (Esc, backdrop or buttons) calls onClose. */
export function Dialog({ title, children, footer, onClose }: { title: string; children: ReactNode; footer?: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close()
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => ref.current?.close()} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  )
}

export function useToast(): [ReactNode, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])
  const node = message ? (
    <div className="toast" role="status">
      {message}
    </div>
  ) : null
  return [node, setMessage]
}

export function Corners() {
  return <span className="corner-b" aria-hidden />
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}
