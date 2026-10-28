import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { Uuid } from '../../common/http/schemas.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

export const NOTIFICATION_KINDS = ['bill', 'budget', 'goal', 'debt', 'income', 'security', 'sync', 'account'] as const;

export const NotificationAction = z
  .object({
    key: z.string(),
    label: z.string(),
    target: z
      .object({
        path: z.string(),
        params: z.record(z.string(), z.string()).optional(),
      })
      .nullable()
      .meta({ description: 'Where the app goes when the person taps the action.' }),
  })
  .meta({ id: 'NotificationAction' });

export const Notification = z
  .object({
    id: z.string(),
    kind: z.enum(NOTIFICATION_KINDS),
    title: z.string(),
    body: z.string(),
    amount: z.string().nullable().meta({ description: 'Minor units when shown; null when hidden.' }),
    readAt: z.string().nullable(),
    dismissedAt: z.string().nullable(),
    security: z.boolean().meta({ description: 'Security notices cannot be muted (DESIGN.md page 27).' }),
    actions: z.array(NotificationAction),
    createdAt: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'Notification' });

export const NotificationPage = z
  .object({ items: z.array(Notification), nextCursor: z.string().nullable(), unreadCount: z.number().int() })
  .meta({ id: 'NotificationPage' });

export const NotificationParams = WorkspaceParams.extend({ notificationId: Uuid });

const tag = 'Notifications';
const base = '/v1/workspaces/:workspaceId/notifications';
const viewer = { kind: 'workspace', minRole: 'viewer' } as const;

export const notificationRoutes = {
  list: defineRoute({
    name: 'listNotifications',
    method: 'GET',
    path: base,
    tag,
    summary: 'The in-app inbox for the signed-in member',
    description: 'Newest first. Filter by kind chip. Dismissed rows are hidden.',
    access: viewer,
    params: WorkspaceParams,
    query: z.object({
      kind: z.enum(NOTIFICATION_KINDS).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    status: 200,
    response: NotificationPage,
    errors: [400, 401, 404],
  }),
  markRead: defineRoute({
    name: 'markNotificationRead',
    method: 'POST',
    path: `${base}/:notificationId/read`,
    tag,
    summary: 'Mark one notification read',
    access: viewer,
    params: NotificationParams,
    status: 200,
    response: Notification,
    errors: [400, 401, 404],
  }),
  markAllRead: defineRoute({
    name: 'markAllNotificationsRead',
    method: 'POST',
    path: `${base}/mark-all-read`,
    tag,
    summary: 'Mark every unread notification read',
    access: viewer,
    params: WorkspaceParams,
    status: 200,
    response: z.object({ updated: z.number().int() }).meta({ id: 'NotificationsMarked' }),
    errors: [400, 401, 404],
  }),
  dismiss: defineRoute({
    name: 'dismissNotification',
    method: 'POST',
    path: `${base}/:notificationId/dismiss`,
    tag,
    summary: 'Dismiss a notification from the inbox',
    description: 'Security notices cannot be dismissed until answered.',
    access: viewer,
    params: NotificationParams,
    status: 200,
    response: Notification,
    errors: [400, 401, 403, 404],
  }),
};
