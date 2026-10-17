# ADR-0005: Four workspace roles, enforced on the server, with no per-account privacy in first release (DEC-04)

- Status: Accepted
- Date: 2026-10-16
- Story: MYL-004
- Spec: §2.2, §2.3, §2.4, §14.3, DEC-04, DEC-11

## Context

Workspaces are the primary boundary for both data and permissions. Every record carries a `workspaceId`, and every request must be checked on the server for active membership and for the permission that specific action needs (§2.2, §2.4). §2.3 proposes an Owner / Admin / Editor / Viewer matrix and leaves three questions open:

1. May admins export all workspace data?
2. Is account-level privacy supported inside a shared workspace?
3. Can viewers see all balances?

The first release ships with personal workspaces only. Family and business workspaces are gated, but the model must already be multi-user (CON-05).

## Options

| Question | Options considered | Chosen |
|---|---|---|
| Role set | (a) Owner / Admin / Editor / Viewer; (b) Owner / Member only; (c) fully custom permissions | **(a)**. It covers family and business needs without the cost of a custom permission builder. |
| Admin export | (a) Never; (b) always; (c) only if the owner grants it per workspace | **(c), off by default** |
| Account-level privacy in a shared workspace | (a) Hidden accounts inside shared workspaces; (b) none, so a shared workspace shares every account in it | **(b)**. Private money belongs in the user's personal workspace. Partial visibility would make every report, budget and net-worth figure depend on who is asking. |
| Viewer balances | (a) Hide balances; (b) see everything in the workspace, read-only | **(b)**. Viewer is a read-only role; hiding balances would bring back problem 2. |

## Decision

| Capability | Owner | Admin | Editor | Viewer |
|---|---|---|---|---|
| View workspace, accounts, balances, reports | Yes | Yes | Yes | Yes |
| Create, edit, void transactions | Yes | Yes | Yes | No |
| Create and edit accounts | Yes | Yes | Yes | No |
| Manage categories and budgets | Yes | Yes | Yes (the owner can switch this off) | No |
| Invite and remove members | Yes | Editors and viewers only | No | No |
| Change roles | Yes | Editors and viewers only, never to admin | No | No |
| Export all workspace data | Yes | Only if the owner grants it | No | No |
| Transfer ownership | Yes, with recent sign-in | No | No | No |
| Delete workspace | Yes, with recent sign-in and confirmation | No | No | No |

- Every workspace has **exactly one owner**. The owner cannot leave without first transferring ownership.
- The **`workspaces` module** owns workspaces, memberships and invitations (DEC-11). It exports one membership and role resolver, and every other module's `policies/` uses it.
- Access is **deny by default**. The `workspaceId`, role and ownership a client sends are never trusted; the server resolves them from the session user and the target resource, including parent and child records (§2.4).
- Roles are **not** placed in tokens (ADR-0004), so a role change or removal takes effect on the next request.
- Role changes, removals, exports, ownership transfers and deletions are **audited** (§2.4).
- Removing a member never deletes their identity or their personal workspace. Sharing never exposes anyone's personal workspace (§2.2).

## Consequences

- Every endpoint declares a required capability, and tests cover each role for it. A role matrix test table becomes part of every workspace-scoped story.
- A user who wants private money and shared money keeps two workspaces. Onboarding copy must explain this.
- Per-account privacy can be added later only through a new ADR, because it changes how every aggregate is computed.
- In the first release each user only has their own personal workspace as owner. The matrix is still enforced from day one, so family and business workspaces need no security rework.
