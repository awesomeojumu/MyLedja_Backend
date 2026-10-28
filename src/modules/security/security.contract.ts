import { z } from 'zod';
import { defineRoute } from '../../common/http/contract.js';
import { Uuid } from '../../common/http/schemas.js';
import { NewPassword, SessionResponse } from '../auth/auth.contract.js';
import { WorkspaceParams } from '../workspaces/workspaces.contract.js';

/** Settings › Security and the sign-in steps of Phase 3 (build plan B3.1 to B3.4, B3.9). */

export const RECHECK_WINDOW_MS = 15 * 60_000;
export const TRUSTED_DEVICE_DAYS = 30;

const SixDigits = z.string().regex(/^\d{6}$/, { error: 'Enter the 6-digit code from your authenticator app' });
const StaySignedIn = z.boolean().default(false);
const DeviceName = z.string().trim().max(100).optional();
const WebAuthnResponse = z
  .record(z.string(), z.unknown())
  .meta({ description: "The browser's or phone's WebAuthn response, as JSON." });

export const TwoFactorSignInBody = z
  .object({
    challengeToken: z.string().max(2000),
    code: SixDigits.optional(),
    backupCode: z.string().trim().max(20).optional(),
    trustDevice: z.boolean().default(false).meta({ description: '"Trust this device for 30 days".' }),
    staySignedIn: StaySignedIn,
    deviceName: DeviceName,
  })
  .refine((v) => v.code || v.backupCode, {
    error: 'Enter the 6-digit code from your authenticator app',
    path: ['code'],
  });

export const TwoFactorSessionResponse = SessionResponse.extend({
  trustedDeviceToken: z
    .string()
    .nullable()
    .meta({ description: 'Send as trustedDeviceToken on later sign-ins from this device.' }),
}).meta({ id: 'TwoFactorSessionResponse' });

export const PasskeyOptions = z
  .object({
    challengeToken: z.string(),
    options: z
      .record(z.string(), z.unknown())
      .meta({ description: 'Pass to navigator.credentials or the phone passkey module.' }),
  })
  .meta({ id: 'PasskeyOptions' });

export const PasskeySignInBody = z.object({
  challengeToken: z.string().max(2000),
  response: WebAuthnResponse,
  staySignedIn: StaySignedIn,
  deviceName: DeviceName,
});

export const RecheckBody = z
  .object({
    password: z.string().max(200).optional(),
    challengeToken: z.string().max(2000).optional(),
    response: WebAuthnResponse.optional(),
  })
  .refine((v) => v.password || (v.challengeToken && v.response), { error: 'Enter your password', path: ['password'] });

export const Passkey = z
  .object({ id: z.string(), name: z.string(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable() })
  .meta({ id: 'Passkey' });

export const SecurityStatus = z
  .object({
    hasPassword: z.boolean(),
    twoFactorOn: z.boolean(),
    backupCodesLeft: z.number().int(),
    passkeys: z.array(Passkey),
    recheckedUntil: z.iso
      .datetime()
      .nullable()
      .meta({ description: 'Sensitive actions work without asking again until then.' }),
  })
  .meta({ id: 'SecurityStatus' });

export const TwoFactorSetup = z
  .object({
    secret: z.string().meta({ description: '"Can\'t scan? Copy key".' }),
    otpauthUrl: z.string(),
    qrSvg: z.string().meta({ description: 'The QR code as SVG markup.' }),
  })
  .meta({ id: 'TwoFactorSetup' });

export const BackupCodes = z.object({ backupCodes: z.array(z.string()) }).meta({ id: 'BackupCodes' });

export const AddPasskeyBody = z.object({
  challengeToken: z.string().max(2000),
  response: WebAuthnResponse,
  name: z.string().trim().min(1, { error: 'Name this device' }).max(60),
});

export const DeviceSession = z
  .object({
    id: z.string(),
    deviceName: z.string().nullable(),
    staysSignedIn: z.boolean().meta({ description: 'A web session with "Stay signed in" (labelled in Settings).' }),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .meta({ id: 'DeviceSession' });

export const ChangePasswordBody = z.object({ currentPassword: z.string().max(200), newPassword: NewPassword });

export const ActivityEvent = z
  .object({
    id: z.string(),
    at: z.iso.datetime(),
    action: z.string().meta({ description: 'For example transaction.created, session.signed_in.' }),
    who: z.string().nullable(),
    device: z.string().nullable(),
    target: z.object({ collection: z.string(), id: z.string() }).nullable(),
  })
  .meta({ id: 'ActivityEvent' });

const SessionParams = z.object({ sessionId: Uuid });
const PasskeyParams = z.object({ passkeyId: z.string().max(400) });

const tag = 'Security';

export const securityRoutes = {
  twoFactorSignIn: defineRoute({
    name: 'signInTwoFactor',
    method: 'POST',
    path: '/v1/auth/two-factor',
    tag,
    summary: 'Finish signing in with a two-factor or backup code',
    description: 'A backup code works once. Five wrong codes: 429, wait 1 minute.',
    access: { kind: 'public' },
    body: TwoFactorSignInBody,
    status: 200,
    response: TwoFactorSessionResponse,
    errors: [400, 401, 429],
  }),
  passkeySignInOptions: defineRoute({
    name: 'passkeySignInOptions',
    method: 'POST',
    path: '/v1/auth/passkey/options',
    tag,
    summary: 'Start "Use a passkey"',
    access: { kind: 'public' },
    status: 200,
    response: PasskeyOptions,
    errors: [404, 429],
  }),
  passkeySignIn: defineRoute({
    name: 'signInPasskey',
    method: 'POST',
    path: '/v1/auth/passkey',
    tag,
    summary: 'Sign in with a passkey',
    access: { kind: 'public' },
    body: PasskeySignInBody,
    status: 200,
    response: SessionResponse,
    errors: [400, 401, 429],
  }),
  recheck: defineRoute({
    name: 'recheck',
    method: 'POST',
    path: '/v1/auth/recheck',
    tag,
    summary: "Confirm it's you before a sensitive action",
    description:
      'Export, backup, password change, turning off two-factor and deleting the account need this within 15 minutes of signing in (DESIGN.md 10.6).',
    access: { kind: 'user' },
    body: RecheckBody,
    status: 200,
    response: SecurityStatus,
    errors: [400, 401, 429],
  }),
  recheckPasskeyOptions: defineRoute({
    name: 'recheckPasskeyOptions',
    method: 'POST',
    path: '/v1/auth/recheck/passkey-options',
    tag,
    summary: 'Start confirming with a passkey instead of the password',
    access: { kind: 'user' },
    status: 200,
    response: PasskeyOptions,
    errors: [401, 404],
  }),
  status: defineRoute({
    name: 'getSecurity',
    method: 'GET',
    path: '/v1/me/security',
    tag,
    summary: 'Two-factor, passkeys and the re-check window',
    access: { kind: 'user' },
    status: 200,
    response: SecurityStatus,
    errors: [401],
  }),
  twoFactorSetup: defineRoute({
    name: 'setUpTwoFactor',
    method: 'POST',
    path: '/v1/me/two-factor/setup',
    tag,
    summary: 'Start setting up two-factor (popup 52)',
    access: { kind: 'user' },
    status: 200,
    response: TwoFactorSetup,
    errors: [401, 409],
  }),
  twoFactorConfirm: defineRoute({
    name: 'confirmTwoFactor',
    method: 'POST',
    path: '/v1/me/two-factor/confirm',
    tag,
    summary: 'Turn two-factor on with the first code; returns 10 backup codes',
    access: { kind: 'user' },
    body: z.object({ code: SixDigits }),
    status: 200,
    response: BackupCodes,
    errors: [400, 401, 409],
  }),
  backupCodes: defineRoute({
    name: 'newBackupCodes',
    method: 'POST',
    path: '/v1/me/two-factor/backup-codes',
    tag,
    summary: 'Replace the backup codes (popup 53)',
    access: { kind: 'user' },
    status: 200,
    response: BackupCodes,
    errors: [401, 403, 409],
  }),
  twoFactorOff: defineRoute({
    name: 'turnOffTwoFactor',
    method: 'DELETE',
    path: '/v1/me/two-factor',
    tag,
    summary: 'Turn two-factor off (asks again)',
    access: { kind: 'user' },
    status: 204,
    response: null,
    errors: [401, 403],
  }),
  passkeyAddOptions: defineRoute({
    name: 'passkeyAddOptions',
    method: 'POST',
    path: '/v1/me/passkeys/options',
    tag,
    summary: 'Start adding a passkey (popup 54)',
    access: { kind: 'user' },
    status: 200,
    response: PasskeyOptions,
    errors: [401, 404],
  }),
  passkeyAdd: defineRoute({
    name: 'addPasskey',
    method: 'POST',
    path: '/v1/me/passkeys',
    tag,
    summary: 'Save a passkey',
    access: { kind: 'user' },
    body: AddPasskeyBody,
    status: 201,
    response: Passkey,
    errors: [400, 401],
  }),
  passkeyRemove: defineRoute({
    name: 'removePasskey',
    method: 'DELETE',
    path: '/v1/me/passkeys/:passkeyId',
    tag,
    summary: 'Remove a passkey',
    access: { kind: 'user' },
    params: PasskeyParams,
    status: 204,
    response: null,
    errors: [401, 404],
  }),
  sessions: defineRoute({
    name: 'listSessions',
    method: 'GET',
    path: '/v1/me/sessions',
    tag,
    summary: 'Devices and sessions',
    access: { kind: 'user' },
    status: 200,
    response: z.object({ sessions: z.array(DeviceSession) }),
    errors: [401],
  }),
  signOutSession: defineRoute({
    name: 'signOutSession',
    method: 'DELETE',
    path: '/v1/me/sessions/:sessionId',
    tag,
    summary: 'Sign out one device; it is refused at once',
    access: { kind: 'user' },
    params: SessionParams,
    status: 204,
    response: null,
    errors: [401, 404],
  }),
  changePassword: defineRoute({
    name: 'changePassword',
    method: 'POST',
    path: '/v1/me/password',
    tag,
    summary: 'Change the password; other devices are signed out',
    access: { kind: 'user' },
    body: ChangePasswordBody,
    status: 204,
    response: null,
    errors: [400, 401, 429],
  }),
  activity: defineRoute({
    name: 'listActivity',
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/activity',
    tag,
    summary: 'Activity log: who, which device, what, when (B3.9)',
    access: { kind: 'workspace', minRole: 'admin' },
    params: WorkspaceParams,
    query: z.object({
      before: z.iso.datetime().optional().meta({ description: 'Cursor: the `at` of the last event already shown.' }),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      action: z
        .string()
        .max(60)
        .optional()
        .meta({ description: 'Prefix filter, for example "session." or "transaction."' }),
    }),
    status: 200,
    response: z.object({ events: z.array(ActivityEvent), nextBefore: z.string().nullable() }),
    errors: [401, 403, 404],
  }),
};
