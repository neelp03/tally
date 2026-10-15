export type Role = 'owner' | 'admin' | 'member'

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 }

/** The minimum role for each action. One table, so the rules are easy to audit. */
export const PERMISSIONS = {
  'posts.read': 'member',
  'posts.triage': 'member', // status, tags, merge, comments, internal notes, create
  'posts.delete': 'admin',
  'boards.manage': 'admin',
  'members.read': 'member',
  'members.manage': 'admin',
  'apikeys.manage': 'admin',
  'audit.read': 'admin',
  'billing.read': 'admin',
  'billing.manage': 'owner',
  'org.manage': 'owner',
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export function can(role: Role, permission: Permission): boolean {
  return RANK[role] >= RANK[PERMISSIONS[permission]]
}

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'member'
}

/**
 * Whether `actor` may change a member whose role is `from` to role `to`.
 * Ownership never moves through this path, and only the owner can change admins
 * (so an admin can't demote another admin and then remove them).
 */
export function canChangeRole(actor: Role, from: Role, to: Role): boolean {
  if (!can(actor, 'members.manage')) return false
  if (from === 'owner' || to === 'owner') return false
  if (from === 'admin' && actor !== 'owner') return false
  return true
}
