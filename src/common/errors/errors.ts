import { z } from 'zod';

/** The one error shape (TECH-SPEC 5.3). `message` follows DESIGN.md 2.12 and can be shown as it is. */
export const ErrorBody = z
  .object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
    retryAfterSeconds: z.number().int().optional(),
  })
  .meta({ id: 'Error' });
export type ErrorBody = z.infer<typeof ErrorBody>;

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly userMessage: string,
    readonly extra: { field?: string; retryAfterSeconds?: number } = {},
  ) {
    super(code);
    this.name = 'AppError';
  }

  body(): ErrorBody {
    return { code: this.code, message: this.userMessage, ...this.extra };
  }
}

export const MESSAGES = {
  fieldFallback: 'Check this field and try again.',
  bodyUnreadable: "We couldn't read this request. Update the app and try again.",
  signInNeeded: 'Sign in to continue.',
  notFound: "We couldn't find this. It may have been removed.",
  forbidden: "Your role in this workspace doesn't allow this.",
  notImplemented: "This isn't available yet.",
  operationIdMissing: "We couldn't save this. Update the app and try again.",
  operationIdReused: 'This change was already sent with different details. Try again.',
  operationInProgress: 'This change is still being saved. Try again in a moment.',
  tooManyRequests: 'Too many tries. Wait a minute and try again.',
  serverError: "We couldn't save this. Check your connection and try again. Your changes are still here.",
} as const;

export const Errors = {
  validation: (field: string | undefined, message: string) =>
    new AppError(400, 'invalid_input', message, field ? { field } : {}),
  unauthorized: (code = 'sign_in_needed', message: string = MESSAGES.signInNeeded) => new AppError(401, code, message),
  forbidden: () => new AppError(403, 'forbidden', MESSAGES.forbidden),
  notFound: () => new AppError(404, 'not_found', MESSAGES.notFound),
  notImplemented: () => new AppError(501, 'not_implemented', MESSAGES.notImplemented),
  tooMany: (retryAfterSeconds: number, message: string = MESSAGES.tooManyRequests) =>
    new AppError(429, 'too_many_attempts', message, { retryAfterSeconds }),
};
