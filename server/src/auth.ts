import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Request, Response } from 'express'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

export const SESSION_COOKIE = 'tally_session'
export const VOTER_COOKIE = 'tally_voter'
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 32)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [saltHex, hashHex] = (stored ?? '').split(':')
  if (!saltHex || !hashHex) {
    // Spend the same time as a real check so missing accounts can't be told apart by timing.
    await scryptAsync(password, Buffer.alloc(16), 32)
    return false
  }
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(expected, actual)
}

/** A signed value: base64url(json).hmac. Used for sessions and short-lived OAuth/billing state. */
export function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

export function unsign<T extends { exp: number }>(token: string | undefined, secret: string): T | null {
  if (!token) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T
    return payload.exp > Date.now() ? payload : null
  } catch {
    return null
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const key = part.slice(0, i).trim()
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function setCookie(res: Response, name: string, value: string, opts: { maxAgeMs: number; secure: boolean }) {
  res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: opts.secure, maxAge: opts.maxAgeMs, path: '/' })
}

export function startSession(res: Response, userId: string, secret: string, secure: boolean) {
  setCookie(res, SESSION_COOKIE, sign({ uid: userId, exp: Date.now() + SESSION_TTL_MS }, secret), { maxAgeMs: SESSION_TTL_MS, secure })
}

export function sessionUserId(req: Request, secret: string): string | null {
  return unsign<{ uid: string; exp: number }>(parseCookies(req)[SESSION_COOKIE], secret)?.uid ?? null
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}
