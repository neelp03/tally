import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, get, post, type OrgSummary, type Role, type User } from './api'

export interface Invite {
  id: string
  role: Role
  org_name: string
  created_at: string
}

export interface Config {
  googleEnabled: boolean
  demo: boolean
  billingMode: 'stripe' | 'demo'
}

interface SessionState {
  user: User | null
  orgs: OrgSummary[]
  invites: Invite[]
  config: Config
  loading: boolean
  refresh(): Promise<void>
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [config, setConfig] = useState<Config>({ googleEnabled: false, demo: false, billingMode: 'demo' })
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const me = await get<{ user: User | null; orgs: OrgSummary[]; invites: Invite[] }>('/me')
      setUser(me.user)
      setOrgs(me.orgs)
      setInvites(me.invites)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setOrgs([])
        setInvites([])
      } else {
        throw err
      }
    }
  }, [])

  useEffect(() => {
    Promise.all([refresh(), get<Config>('/config').then(setConfig)])
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [refresh])

  const signOut = useCallback(async () => {
    await post('/auth/logout')
    setUser(null)
    setOrgs([])
    setInvites([])
  }, [])

  return (
    <SessionContext.Provider value={{ user, orgs, invites, config, loading, refresh, signOut }}>{children}</SessionContext.Provider>
  )
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
