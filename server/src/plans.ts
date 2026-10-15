export type Plan = 'free' | 'pro' | 'business'

export interface PlanLimits {
  name: string
  priceMonthly: number
  /** null means unlimited */
  boards: number | null
  postsPerMonth: number
  seats: number
  apiCallsPerMonth: number
  apiRequestsPerMinute: number
  ssoDomain: boolean
  auditExport: boolean
}

export const PLANS: Record<Plan, PlanLimits> = {
  free: {
    name: 'Free',
    priceMonthly: 0,
    boards: 1,
    postsPerMonth: 50,
    seats: 2,
    apiCallsPerMonth: 0,
    apiRequestsPerMinute: 0,
    ssoDomain: false,
    auditExport: false,
  },
  pro: {
    name: 'Pro',
    priceMonthly: 29,
    boards: 10,
    postsPerMonth: 500,
    seats: 5,
    apiCallsPerMonth: 50_000,
    apiRequestsPerMinute: 120,
    ssoDomain: false,
    auditExport: false,
  },
  business: {
    name: 'Business',
    priceMonthly: 99,
    boards: null,
    postsPerMonth: 5_000,
    seats: 25,
    apiCallsPerMonth: 500_000,
    apiRequestsPerMinute: 600,
    ssoDomain: true,
    auditExport: true,
  },
}

export const PAID_PLANS = ['pro', 'business'] as const
export type PaidPlan = (typeof PAID_PLANS)[number]

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === 'pro' || value === 'business'
}
