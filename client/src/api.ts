export type Role = 'owner' | 'admin' | 'member'
export type Plan = 'free' | 'pro' | 'business'
export type Status = 'open' | 'under_review' | 'planned' | 'in_progress' | 'shipped' | 'closed'

export const STATUSES: Status[] = ['open', 'under_review', 'planned', 'in_progress', 'shipped', 'closed']
export const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  under_review: 'Under review',
  planned: 'Planned',
  in_progress: 'In progress',
  shipped: 'Shipped',
  closed: 'Closed',
}

export interface User {
  id: string
  email: string
  name: string
  is_platform_admin: boolean
}

export interface OrgSummary {
  id: string
  name: string
  slug: string
  plan: Plan
  role: Role
}

export interface PlanLimits {
  name: string
  priceMonthly: number
  boards: number | null
  postsPerMonth: number
  seats: number
  apiCallsPerMonth: number
  apiRequestsPerMinute: number
  ssoDomain: boolean
  auditExport: boolean
}

export interface Usage {
  posts: { used: number; limit: number }
  boards: { used: number; limit: number | null }
  seats: { used: number; limit: number }
  apiCalls: { used: number; limit: number }
  periodStart: string
}

export interface OrgDetail {
  id: string
  name: string
  slug: string
  plan: Plan
  role: Role
  subscription_status: string | null
  current_period_end: string | null
  sso_domain: string | null
  is_demo: boolean
  usage: Usage
  limits: PlanLimits
}

export interface Board {
  id: string
  name: string
  slug: string
  is_public: boolean
  post_count?: number
}

export interface Post {
  id: string
  number: number
  title: string
  body: string
  status: Status
  tags: string[]
  vote_count: number
  comment_count: number
  author_name: string
  created_at: string
  updated_at: string
  merged_into_id: string | null
  board_id: string
  board_name: string
  board_slug: string
}

export interface Comment {
  id: string
  author_name: string
  body: string
  is_team: boolean
  is_internal: boolean
  created_at: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-requested-with': 'tally',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network', "Can't reach the server. Check your connection and try again.")
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = data?.error ?? {}
    const { code, message, ...details } = err
    throw new ApiError(res.status, code ?? 'error', message ?? `Request failed (${res.status}).`, details)
  }
  return data as T
}

export const get = <T = any>(path: string) => api<T>('GET', path)
export const post = <T = any>(path: string, body: unknown = {}) => api<T>('POST', path, body)
export const patch = <T = any>(path: string, body: unknown) => api<T>('PATCH', path, body)
export const del = <T = any>(path: string) => api<T>('DELETE', path)

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ''))).toUpperCase()
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' })

export function ago(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000
  const abs = Math.abs(s)
  if (abs < 60) return 'now'
  if (abs < 3600) return `${Math.round(abs / 60)}m`
  if (abs < 86400) return `${Math.round(abs / 3600)}h`
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)}d`
  if (abs < 86400 * 365) return `${Math.round(abs / (86400 * 30))}mo`
  return rtf.format(Math.round(s / (86400 * 365)), 'year')
}

/** "5m ago", or "just now". */
export function agoText(iso: string): string {
  const a = ago(iso)
  return a === 'now' ? 'just now' : `${a} ago`
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function dateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fmt = (n: number) => n.toLocaleString('en-US')
