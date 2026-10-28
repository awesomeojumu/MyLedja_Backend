import type { z } from 'zod';
import { Errors, MESSAGES } from '../errors/errors.js';

/** Parses one part of a request, turning the first Zod issue into a 400 with its DESIGN.md 2.12 message. */
export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join('.') : undefined;
  const message =
    issue && issue.message && !issue.message.startsWith('Invalid') && !issue.message.startsWith('Too ')
      ? issue.message
      : issue?.code === 'unrecognized_keys'
        ? MESSAGES.bodyUnreadable
        : MESSAGES.fieldFallback;
  throw Errors.validation(field, message);
}
