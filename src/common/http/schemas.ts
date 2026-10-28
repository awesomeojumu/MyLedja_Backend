import { z } from 'zod';

export const Uuid = z.uuid({ error: 'Check this link and try again.' });

export const Email = z
  .string({ error: 'Enter your email address, for example ada@example.com' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter your email address, for example ada@example.com' }).max(254));

/** An amount in JSON: a string of whole minor units, never a number (TECH-SPEC 6.5). */
export const MinorAmount = z
  .string({ error: 'Enter an amount in naira, for example 25000' })
  .regex(/^-?(0|[1-9]\d{0,17})$/, { error: 'Enter an amount in naira, for example 25000' })
  .meta({ description: 'Whole minor units (kobo) as a string, for example "1845000" for ₦18,450.00.' });

/** A calendar day in the workspace's time zone (TECH-SPEC 6.4). */
export const LocalDate = z
  .string({ error: 'Choose a date' })
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { error: 'Choose a date' })
  .refine(
    (v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
    {
      error: 'Choose a date',
    },
  )
  .meta({ description: 'YYYY-MM-DD in the workspace time zone.' });

export const OperationIdHeader = z.uuid();

/** A calendar month, YYYY-MM. */
export const Month = z
  .string({ error: 'Choose a month' })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: 'Choose a month' })
  .meta({ description: 'YYYY-MM.' });

/** Cursor paging (TECH-SPEC 5.3): pass `nextCursor` back as `cursor`. Never page numbers. */
export const PageQuery = {
  cursor: z.string().max(200).optional().meta({ description: "From the last page's `nextCursor`." }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};

/** The version an edit started from (TECH-SPEC 5.7). An old one is refused with 409 and the current record. */
export const BaseVersion = z
  .number({ error: 'Update the app and try again.' })
  .int()
  .min(1)
  .meta({ description: 'The `version` the change started from.' });
