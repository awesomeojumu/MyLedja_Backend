import type { Role } from '../auth/roles.js';

declare const contextBrand: unique symbol;

/**
 * Who is acting in which workspace. Only the access guard and system jobs make one, so a repository
 * call can't be written without a checked workspace (TECH-SPEC 5.4).
 */
export type WorkspaceContext = {
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly role: Role | 'system';
  readonly [contextBrand]: true;
};

export function memberContext(input: {
  workspaceId: string;
  userId: string;
  sessionId: string | null;
  role: Role;
}): WorkspaceContext {
  return Object.freeze({ ...input }) as WorkspaceContext;
}

/** For jobs and migrations acting on a workspace's behalf. */
export function systemContext(workspaceId: string): WorkspaceContext {
  return Object.freeze({ workspaceId, userId: null, sessionId: null, role: 'system' }) as WorkspaceContext;
}
