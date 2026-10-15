import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export const notFound = (what = 'Not found.') => new HttpError(404, 'not_found', what)
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message)

/** Parse a request body with a zod schema; a mismatch becomes a 400 with the first problem. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue.path.join('.')
    throw new HttpError(400, 'invalid_request', field ? `${field}: ${issue.message}` : issue.message)
  }
  return result.data
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } })
    return
  }
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'bad_request', message: status === 413 ? 'Request body is too large.' : 'The request could not be read.' } })
    return
  }
  console.error(err)
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on the server.' } })
}

export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null
  return ip?.startsWith('::ffff:') ? ip.slice(7) : ip
}
