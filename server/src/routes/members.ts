import { Router } from 'express'
import { z } from 'zod'
import { audit } from '../audit.js'
import { actor, orgAccess, tenant, type Deps } from '../context.js'
import { clientIp, forbidden, HttpError, notFound, parse } from '../http.js'
import { canChangeRole, type Role } from '../rbac.js'
import { assertSeatAvailable } from '../usage.js'

export function memberRoutes(deps: Deps): Router {
  const r = Router()
  const { db } = deps

  r.get('/orgs/:orgId/members', orgAccess(deps, 'members.read'), async (req, res) => {
    const data = await db.tx(tenant(req), async (c) => {
      const members = await c.query(
        `SELECT u.id, u.name, u.email, m.role, m.created_at, m.last_active_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`,
      )
      const invites = await c.query('SELECT id, email, role, created_at FROM invites ORDER BY created_at DESC')
      return { members: members.rows, invites: invites.rows }
    })
    res.json(data)
  })

  r.post('/orgs/:orgId/invites', orgAccess(deps, 'members.manage'), async (req, res) => {
    const body = parse(
      z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'member']).default('member') }),
      req.body,
    )
    const invite = await db.tx(tenant(req), async (c) => {
      const already = await c.query('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1', [body.email])
      if (already.rowCount) throw new HttpError(409, 'already_member', `${body.email} is already a member.`)
      const pending = await c.query('SELECT 1 FROM invites WHERE email = $1', [body.email])
      if (pending.rowCount) throw new HttpError(409, 'already_invited', `${body.email} already has an invite.`)
      await assertSeatAvailable(c, req.org!.id)
      const { rows } = await c.query(
        'INSERT INTO invites (org_id, email, role, invited_by) VALUES ($1, $2, $3, $4) RETURNING id, email, role, created_at',
        [req.org!.id, body.email, body.role, req.user!.id],
      )
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'member.invited', target: body.email, ip: clientIp(req), metadata: { role: body.role } })
      return rows[0]
    })
    res.status(201).json({ invite })
  })

  r.delete('/orgs/:orgId/invites/:inviteId', orgAccess(deps, 'members.manage'), async (req, res) => {
    await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query('DELETE FROM invites WHERE id = $1 RETURNING email', [req.params.inviteId])
      if (!rows[0]) throw notFound('Invite not found.')
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: 'member.invite_revoked', target: rows[0].email, ip: clientIp(req) })
    })
    res.status(204).end()
  })

  r.patch('/orgs/:orgId/members/:userId', orgAccess(deps, 'members.manage'), async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(['admin', 'member']) }), req.body)
    await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query<{ role: Role; email: string }>(
        'SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1',
        [req.params.userId],
      )
      const target = rows[0]
      if (!target) throw notFound('Member not found.')
      if (!canChangeRole(req.org!.role, target.role, role)) throw forbidden("You can't change that member's role.")
      await c.query('UPDATE memberships SET role = $2 WHERE user_id = $1 AND org_id = $3', [req.params.userId, role, req.org!.id])
      await audit(c, {
        orgId: req.org!.id,
        actor: actor(req),
        action: 'member.role_changed',
        target: target.email,
        ip: clientIp(req),
        metadata: { from: target.role, to: role },
      })
    })
    res.json({ ok: true })
  })

  /** Admins remove members; anyone may remove themselves (leave). The owner can't be removed. */
  r.delete('/orgs/:orgId/members/:userId', orgAccess(deps, 'members.read'), async (req, res) => {
    const userId = String(req.params.userId)
    const leaving = userId === req.user!.id
    if (!leaving && req.org!.role === 'member') throw forbidden('Only admins can remove members.')
    await db.tx(tenant(req), async (c) => {
      const { rows } = await c.query<{ role: Role; email: string }>(
        'SELECT m.role, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1',
        [userId],
      )
      const target = rows[0]
      if (!target) throw notFound('Member not found.')
      if (target.role === 'owner') throw forbidden('The owner cannot be removed.')
      if (target.role === 'admin' && req.org!.role === 'admin' && !leaving) throw forbidden('Only the owner can remove admins.')
      await c.query('DELETE FROM memberships WHERE user_id = $1 AND org_id = $2', [userId, req.org!.id])
      await audit(c, { orgId: req.org!.id, actor: actor(req), action: leaving ? 'member.left' : 'member.removed', target: target.email, ip: clientIp(req) })
    })
    res.status(204).end()
  })

  return r
}
