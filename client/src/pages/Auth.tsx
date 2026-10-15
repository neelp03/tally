import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { post } from '../api'
import { Corners, Logo } from '../components/ui'
import { useSession } from '../session'

const GOOGLE_ERRORS: Record<string, string> = {
  google_state: 'Google sign-in expired. Try again.',
  google_token: "Google didn't confirm your account. Use a verified Google address.",
}

export default function Auth({ mode }: { mode: 'signin' | 'signup' }) {
  const { user, config, refresh } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(GOOGLE_ERRORS[params.get('error') ?? ''] ?? null)
  const [busy, setBusy] = useState(false)
  const signup = mode === 'signup'

  if (user) return <Navigate to="/app" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (signup) await post('/auth/register', { name, email, password, ...(orgName ? { orgName } : {}) })
      else await post('/auth/login', { email, password })
      await refresh()
      navigate('/app')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="center-page mosaic">
      <div className="auth-card panel corners">
        <Corners />
        <div className="auth-logo">
          <Logo />
        </div>
        <div className="segmented auth-tabs" role="tablist">
          <Link role="tab" aria-selected={!signup} className={!signup ? 'on' : ''} to="/signin">
            Sign in
          </Link>
          <Link role="tab" aria-selected={signup} className={signup ? 'on' : ''} to="/signup">
            Create account
          </Link>
        </div>

        {config.googleEnabled && (
          <>
            <a className="btn btn-block" href="/api/auth/google">
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
              </svg>
              Continue with Google
            </a>
            <div className="divider label">or</div>
          </>
        )}

        <form className="auth-form" onSubmit={submit}>
          {signup && (
            <>
              <label className="field">
                <span className="label">Your name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
              </label>
              <label className="field">
                <span className="label">Organization name</span>
                <input className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} maxLength={80} placeholder="Leave empty if you were invited" />
              </label>
            </>
          )}
          <label className="field">
            <span className="label">Work email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="jane@company.com" />
          </label>
          <label className="field">
            <span className="field-row">
              <span className="label">Password</span>
              {signup && <span className="muted hint">At least 8 characters</span>}
            </span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={signup ? 8 : undefined}
              autoComplete={signup ? 'new-password' : 'current-password'}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {signup ? 'Create account' : 'Sign in'}
          </button>
        </form>
        {signup && <p className="muted auth-note">Start on the Free plan. Upgrade any time.</p>}
      </div>
    </div>
  )
}
