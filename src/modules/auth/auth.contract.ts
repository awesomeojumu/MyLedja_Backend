import { z } from 'zod';
import { ErrorBody } from '../../common/errors/errors.js';
import { defineRoute } from '../../common/http/contract.js';
import { Email } from '../../common/http/schemas.js';
import { isCommonPassword } from './common-passwords.js';

export const PASSWORD_MIN_LENGTH = 10;
export const CODE_TTL_SECONDS = 600;
export const CODE_RESEND_SECONDS = 45;
export const ACCESS_TOKEN_TTL_SECONDS = 900;

const Name = z
  .string({ error: 'Add your name' })
  .trim()
  .min(1, { error: 'Add your name' })
  .max(100, { error: 'Use 100 characters or fewer' });

/** A password being set: the same rules on Sign up and Recover (TECH-SPEC 10). */
export const NewPassword = z
  .string({ error: `Use at least ${PASSWORD_MIN_LENGTH} characters` })
  .min(PASSWORD_MIN_LENGTH, { error: `Use at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(200, { error: 'Use 200 characters or fewer' })
  .refine((v) => !isCommonPassword(v), { error: 'This password is too common. Choose another one' });

const Code = z.string({ error: 'Enter the 6-digit code from the email' }).regex(/^\d{6}$/, {
  error: 'Enter the 6-digit code from the email',
});

const StaySignedIn = z.boolean().default(false).meta({
  description:
    'Web only. When true the refresh token is set as an HttpOnly cookie and `refreshToken` comes back null. Phones send false and keep the token in Keychain or Keystore.',
});

const DeviceName = z.string().trim().max(100).optional().meta({ description: 'Shown in Settings › Security.' });

export const User = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    setupComplete: z.boolean().meta({ description: 'False until Welcome is finished; the app opens Welcome.' }),
    workspaceId: z.string().meta({ description: 'The Personal workspace.' }),
    workspaceName: z.string(),
  })
  .meta({ id: 'User' });

export const Tokens = z
  .object({
    accessToken: z.string(),
    accessTokenExpiresIn: z.number().int().meta({ description: 'Seconds (900).' }),
    refreshToken: z.string().nullable().meta({ description: 'Null when the refresh token was set as a cookie.' }),
  })
  .meta({ id: 'Tokens' });

export const SessionResponse = Tokens.extend({ user: User }).meta({ id: 'SessionResponse' });

/** Sign-in answer when two-factor is on: finish with POST /v1/auth/two-factor (B3.1). */
export const TwoFactorRequired = z
  .object({
    twoFactorRequired: z.literal(true),
    challengeToken: z.string().meta({ description: 'Valid for 10 minutes. Send it back with the code.' }),
  })
  .meta({ id: 'TwoFactorRequired' });

export const SignInResponse = z.union([SessionResponse, TwoFactorRequired]).meta({ id: 'SignInResponse' });

export const CodeSent = z
  .object({
    codeExpiresInSeconds: z.literal(CODE_TTL_SECONDS),
    resendAfterSeconds: z.literal(CODE_RESEND_SECONDS),
  })
  .meta({ id: 'CodeSent' });

export const GoogleLinkNeeded = ErrorBody.extend({
  code: z.literal('google_link_needed'),
  email: z.string(),
  linkToken: z.string().meta({
    description:
      'Send as `googleLinkToken` with a password sign-in, or with a recovery email code, to link Google (TECH-SPEC 5.8).',
  }),
}).meta({ id: 'GoogleLinkNeeded' });

export const SignUpBody = z.object({
  name: Name,
  email: Email,
  password: NewPassword,
  termsAccepted: z.literal(true, { error: 'Agree to the terms to continue' }),
});

export const ResendCodeBody = z.object({
  email: Email,
  purpose: z.enum(['sign_up', 'recover']).default('sign_up'),
});

export const VerifyEmailBody = z.object({
  email: Email,
  code: Code,
  staySignedIn: StaySignedIn,
  deviceName: DeviceName,
});

export const SignInBody = z
  .object({
    email: Email,
    password: z.string().max(200).optional(),
    code: Code.optional().meta({
      description:
        'Recovery email code. With `googleLinkToken`, proves ownership of an existing password account without the password (B0.8 / TECH-SPEC 5.8).',
    }),
    staySignedIn: StaySignedIn,
    deviceName: DeviceName,
    googleLinkToken: z.string().max(4000).optional().meta({ description: 'From a google_link_needed answer.' }),
    trustedDeviceToken: z.string().max(200).optional().meta({
      description: 'From a two-factor sign-in with "Trust this device for 30 days"; skips the code on this device.',
    }),
  })
  .superRefine((v, ctx) => {
    if (v.code !== undefined) {
      if (!v.googleLinkToken) {
        ctx.addIssue({
          code: 'custom',
          message: 'Continue with Google again to link it.',
          path: ['googleLinkToken'],
        });
      }
      return;
    }
    if (!v.password) {
      ctx.addIssue({ code: 'custom', message: 'Enter your password', path: ['password'] });
    }
  });

export const GoogleBody = z.object({
  idToken: z.string().min(1).max(4000),
  trustedDeviceToken: z.string().max(200).optional(),
  staySignedIn: StaySignedIn,
  deviceName: DeviceName,
});

export const RefreshBody = z.object({
  refreshToken: z.string().max(500).optional().meta({ description: 'Omit on web when using the cookie.' }),
});

export const RecoverBody = z.object({ email: Email });

export const NewPasswordBody = z.object({ email: Email, code: Code, newPassword: NewPassword });

export const SignedOutOthers = z.object({ signedOut: z.number().int() });

const tag = 'Auth';

export const authRoutes = {
  signUp: defineRoute({
    name: 'signUp',
    method: 'POST',
    path: '/v1/auth/sign-up',
    tag,
    summary: 'Create an account and email a 6-digit code',
    description:
      'Always answers 202, even if the email is already registered; that email is told it already has an account (P02-04).',
    access: { kind: 'public' },
    body: SignUpBody,
    status: 202,
    response: CodeSent,
    errors: [400, 429],
  }),
  resendCode: defineRoute({
    name: 'resendCode',
    method: 'POST',
    path: '/v1/auth/resend-code',
    tag,
    summary: 'Send a new sign-up or recovery code',
    description: 'Always answers 202. A new code is sent at most every 45 seconds.',
    access: { kind: 'public' },
    body: ResendCodeBody,
    status: 202,
    response: CodeSent,
    errors: [400, 429],
  }),
  verifyEmail: defineRoute({
    name: 'verifyEmail',
    method: 'POST',
    path: '/v1/auth/verify-email',
    tag,
    summary: 'Check the sign-up code; creates the Personal workspace and signs in',
    access: { kind: 'public' },
    body: VerifyEmailBody,
    status: 200,
    response: SessionResponse,
    errors: [400, 429],
  }),
  signIn: defineRoute({
    name: 'signIn',
    method: 'POST',
    path: '/v1/auth/sign-in',
    tag,
    summary: 'Sign in with email and password',
    description:
      'Wrong details give 401 "Email or password is wrong". After five failures, 429 with retryAfterSeconds (60, growing). An unverified account gives 403 email_not_verified and a new code is sent. To link Google after `google_link_needed`, send `googleLinkToken` with the password, or with a recovery `code` from POST /v1/auth/recover (no password).',
    access: { kind: 'public' },
    body: SignInBody,
    status: 200,
    response: SignInResponse,
    errors: [400, 401, 403, 429],
  }),
  google: defineRoute({
    name: 'signInWithGoogle',
    method: 'POST',
    path: '/v1/auth/google',
    tag,
    summary: 'Continue with Google',
    description:
      'A new email creates an account. An email that already has a password answers 409 google_link_needed; link by signing in once with the password and `googleLinkToken`, or with a recovery email code and `googleLinkToken`. 404 google_off when Google sign-in is not set up.',
    access: { kind: 'public' },
    body: GoogleBody,
    status: 200,
    response: SignInResponse,
    errors: [400, 401, 404, 409, 429],
    errorBodies: { 409: GoogleLinkNeeded },
  }),
  refresh: defineRoute({
    name: 'refresh',
    method: 'POST',
    path: '/v1/auth/refresh',
    tag,
    summary: 'Get a new access token; the refresh token rotates',
    description:
      'Needs the X-MyLedja-Client header. With the cookie, the Origin must be an allowed web address. Reusing an old refresh token signs out every session.',
    access: { kind: 'public' },
    body: RefreshBody,
    status: 200,
    response: Tokens,
    errors: [400, 401, 403],
    idempotent: false,
    csrfProtected: true,
  }),
  signOut: defineRoute({
    name: 'signOut',
    method: 'POST',
    path: '/v1/auth/sign-out',
    tag,
    summary: 'Sign out this device',
    access: { kind: 'user' },
    status: 204,
    response: null,
    errors: [401],
  }),
  signOutOthers: defineRoute({
    name: 'signOutOthers',
    method: 'POST',
    path: '/v1/auth/sign-out-others',
    tag,
    summary: 'Sign out every other device',
    access: { kind: 'user' },
    status: 200,
    response: SignedOutOthers,
    errors: [401],
  }),
  recover: defineRoute({
    name: 'recover',
    method: 'POST',
    path: '/v1/auth/recover',
    tag,
    summary: 'Email a recovery code',
    description: 'Always answers 202, whether or not the email is known (P03-01).',
    access: { kind: 'public' },
    body: RecoverBody,
    status: 202,
    response: CodeSent,
    errors: [400, 429],
  }),
  newPassword: defineRoute({
    name: 'newPassword',
    method: 'POST',
    path: '/v1/auth/new-password',
    tag,
    summary: 'Set a new password with a recovery code; signs out every device',
    access: { kind: 'public' },
    body: NewPasswordBody,
    status: 204,
    response: null,
    errors: [400, 429],
  }),
};

export const meRoutes = {
  me: defineRoute({
    name: 'getMe',
    method: 'GET',
    path: '/v1/me',
    tag: 'Me',
    summary: 'The signed-in person',
    access: { kind: 'user' },
    status: 200,
    response: User,
    errors: [401],
  }),
};
