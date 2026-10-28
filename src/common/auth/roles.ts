export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function roleAllows(actual: Role, needed: Role): boolean {
  return RANK[actual] >= RANK[needed];
}
