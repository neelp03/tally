import type { NextFunction, Request, Response } from 'express'
import { clientIp, HttpError } from './http.js'

/**
 * Fixed-window counter per key. In-memory, so limits are per server instance;
 * run several instances behind a shared store (e.g. Redis) to make them global.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>()

  constructor(private windowMs = 60_000) {}

  hit(key: string, limit: number, now = Date.now()) {
    let w = this.windows.get(key)
    if (!w || now - w.start >= this.windowMs) {
      if (this.windows.size > 50_000) this.windows.clear()
      w = { start: now, count: 0 }
      this.windows.set(key, w)
    }
    w.count++
    const resetMs = w.start + this.windowMs - now
    return { allowed: w.count <= limit, limit, remaining: Math.max(0, limit - w.count), resetSeconds: Math.ceil(resetMs / 1000) }
  }
}

export function setRateHeaders(res: Response, r: ReturnType<RateLimiter['hit']>) {
  res.setHeader('X-RateLimit-Limit', r.limit)
  res.setHeader('X-RateLimit-Remaining', r.remaining)
  res.setHeader('X-RateLimit-Reset', r.resetSeconds)
}

/** Per-IP limit for unauthenticated endpoints (sign-up, public posting, demo). */
export function ipLimit(limiter: RateLimiter, name: string, limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(`${name}:${clientIp(req)}`, limit)
    if (!r.allowed) {
      res.setHeader('Retry-After', r.resetSeconds)
      throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.')
    }
    next()
  }
}
