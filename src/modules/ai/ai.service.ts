import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/errors.js';
import { formatNaira } from '../../common/money/money.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { AiConsent, WorkspacesRepository } from '../workspaces/workspaces.repository.js';
import { type AiProvider, type AiTask, AiUnavailable } from './ai.providers.js';
import { redact, transactionLines } from './redact.js';

const MESSAGES = {
  off: 'AI features are off. Turn them on in Settings › AI features.',
  noConsent: 'Turn on this AI feature in Settings › AI features first.',
  failed: "MyLedja couldn't read this with AI right now. Try again later, or upload a CSV.",
} as const;

const NO_CONSENT: AiConsent = { categorize: false, statements: false, healthAdvice: false, updatedAt: null };
const CHUNK_LINES = 150;

const StatementRows = z.object({
  rows: z.array(
    z.object({
      date: z.string().meta({ description: 'YYYY-MM-DD' }),
      description: z.string(),
      amountKobo: z
        .string()
        .meta({ description: 'Whole kobo as an integer string; money in positive, money out negative.' }),
    }),
  ),
});

const Suggestions = z.object({
  suggestions: z.array(z.object({ index: z.number().int(), categoryId: z.string().nullable() })),
});

export type ReadRow = { date: string; description: string; amountMinor: bigint };

/** The AI-provider interface (build plan B4.1, B4.2, B4.4). Every call checks consent first and sends the minimum. */
export class AiService {
  private readonly logger = new Logger('AI');

  constructor(
    private readonly providers: AiProvider[],
    private readonly workspaces: WorkspacesRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  available() {
    return {
      claude: this.providers.some((p) => p.name === 'claude'),
      gemini: this.providers.some((p) => p.name === 'gemini'),
    };
  }

  async consent(ctx: WorkspaceContext): Promise<AiConsent> {
    return (await this.workspaces.get(ctx))?.aiConsent ?? NO_CONSENT;
  }

  async setConsent(ctx: WorkspaceContext, body: Omit<AiConsent, 'updatedAt'>): Promise<AiConsent> {
    const consent = { ...body, updatedAt: this.now() };
    await this.workspaces.setAiConsent(ctx, consent);
    return consent;
  }

  private async require(ctx: WorkspaceContext, use: 'categorize' | 'statements') {
    if (this.providers.length === 0) throw new AppError(404, 'ai_off', MESSAGES.off);
    if (!(await this.consent(ctx))[use]) throw new AppError(403, 'ai_consent_needed', MESSAGES.noConsent);
  }

  /** Tries each provider in turn: Claude, then Gemini after an error, a timeout or a refusal. */
  private async run<T extends z.ZodType>(task: AiTask<T>): Promise<z.output<T>> {
    for (const p of this.providers) {
      try {
        return await p.json(task);
      } catch (e) {
        // Logs carry the provider and the error kind only, never what was sent (TECH-SPEC 10).
        this.logger.warn(
          JSON.stringify({
            event: 'ai_failed',
            provider: p.name,
            error: e instanceof AiUnavailable ? e.message : 'request_failed',
          }),
        );
      }
    }
    throw new AppError(503, 'ai_unavailable', MESSAGES.failed);
  }

  /** Suggests a category from description, amount and date only (B4.4). Null when nothing fits. */
  async categorize(
    ctx: WorkspaceContext,
    items: { description: string; amountMinor: bigint; date: string }[],
    categories: { id: string; name: string; kind: 'income' | 'expense' }[],
  ): Promise<(string | null)[]> {
    await this.require(ctx, 'categorize');
    if (items.length === 0) return [];
    const known = new Set(categories.map((c) => c.id));
    const out = await this.run({
      system:
        'You sort Nigerian bank transactions into budget categories. For each transaction, pick the one category id that fits best from the list, or null if none fits. Money in can only go to income categories, money out only to expense categories. Answer with every index.',
      input: JSON.stringify({
        categories: categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
        transactions: items.map((t, index) => ({
          index,
          description: redact(t.description),
          amount: formatNaira(t.amountMinor),
          date: t.date,
        })),
      }),
      schema: Suggestions,
    });
    const byIndex = new Map(out.suggestions.map((s) => [s.index, s.categoryId]));
    return items.map((_, i) => {
      const id = byIndex.get(i) ?? null;
      return id && known.has(id) ? id : null;
    });
  }

  /**
   * Reads a statement's transaction rows (B4.2). The server extracts the text; this removes account numbers, BVN,
   * card and phone numbers, email and street addresses and the holder's name, and sends only the transaction lines.
   */
  async readStatement(ctx: WorkspaceContext, text: string, holderNames: string[]): Promise<ReadRow[]> {
    await this.require(ctx, 'statements');
    const lines = transactionLines(redact(text, holderNames));
    const rows: ReadRow[] = [];
    for (let i = 0; i < lines.length; i += CHUNK_LINES) {
      const chunk = lines.slice(i, i + CHUNK_LINES);
      const out = await this.run({
        system:
          'You read lines copied from a Nigerian bank statement. Each line is one transaction: a date, a description, amounts and usually a running balance. Return one row per transaction line with the date as YYYY-MM-DD, the description as written, and the amount in whole kobo as an integer string: positive for money in (credit), negative for money out (debit). Use the running balance to tell credits from debits when the line is unclear. Skip opening and closing balance lines.',
        input: chunk.join('\n'),
        schema: StatementRows,
      });
      for (const r of out.rows) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !/^-?\d+$/.test(r.amountKobo)) continue;
        rows.push({ date: r.date, description: r.description.slice(0, 300), amountMinor: BigInt(r.amountKobo) });
      }
    }
    return rows;
  }
}
