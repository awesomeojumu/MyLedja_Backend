import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { memberContext } from '../../../common/workspace/workspace-context.js';
import type { AiConsent, WorkspacesRepository } from '../../workspaces/workspaces.repository.js';
import { type AiProvider, type AiTask, AiUnavailable } from '../ai.providers.js';
import { AiService } from '../ai.service.js';

const ctx = memberContext({
  workspaceId: '00000000-0000-7000-8000-000000000001',
  userId: 'u',
  sessionId: null,
  role: 'owner',
});

function workspaces(consent: Partial<AiConsent>): WorkspacesRepository {
  return {
    get: async () => ({
      aiConsent: { categorize: false, statements: false, healthAdvice: false, updatedAt: null, ...consent },
    }),
  } as unknown as WorkspacesRepository;
}

class Fake implements AiProvider {
  calls: AiTask<z.ZodType>[] = [];
  constructor(
    readonly name: 'claude' | 'gemini',
    private readonly answer: unknown,
  ) {}
  async json<T extends z.ZodType>(task: AiTask<T>): Promise<z.output<T>> {
    this.calls.push(task);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer as z.output<T>;
  }
}

const items = [{ description: 'POS SHOPRITE LEKKI 0123456789', amountMinor: -1_845_000n, date: '2026-10-05' }];
const cats = [{ id: 'cat-food', name: 'Food', kind: 'expense' as const }];

describe('AiService (B4.1, B4.4)', () => {
  it('refuses without consent and sends nothing', async () => {
    const claude = new Fake('claude', { suggestions: [] });
    const ai = new AiService([claude], workspaces({}));
    await expect(ai.categorize(ctx, items, cats)).rejects.toMatchObject({ code: 'ai_consent_needed' });
    await expect(ai.readStatement(ctx, 'x', [])).rejects.toMatchObject({ code: 'ai_consent_needed' });
    expect(claude.calls).toHaveLength(0);
  });

  it('falls back to Gemini when Claude fails or refuses', async () => {
    const claude = new Fake('claude', new AiUnavailable('refused'));
    const gemini = new Fake('gemini', { suggestions: [{ index: 0, categoryId: 'cat-food' }] });
    const ai = new AiService([claude, gemini], workspaces({ categorize: true }));
    expect(await ai.categorize(ctx, items, cats)).toEqual(['cat-food']);
    expect(claude.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(1);
  });

  it('answers 503 when every provider fails', async () => {
    const ai = new AiService(
      [new Fake('claude', new Error('timeout')), new Fake('gemini', new Error('500'))],
      workspaces({ categorize: true }),
    );
    await expect(ai.categorize(ctx, items, cats)).rejects.toMatchObject({ code: 'ai_unavailable' });
  });

  it('categorizing sends only description, amount and date, with numbers removed from the description', async () => {
    const claude = new Fake('claude', { suggestions: [{ index: 0, categoryId: 'not-a-category' }] });
    const ai = new AiService([claude], workspaces({ categorize: true }));
    expect(await ai.categorize(ctx, items, cats)).toEqual([null]);
    const sent = JSON.parse(claude.calls[0]!.input) as { transactions: Record<string, unknown>[] };
    expect(Object.keys(sent.transactions[0]!).sort()).toEqual(['amount', 'date', 'description', 'index']);
    expect(JSON.stringify(sent)).not.toContain('0123456789');
  });

  it('reads statement rows into signed kobo and drops malformed rows', async () => {
    const claude = new Fake('claude', {
      rows: [
        { date: '2026-10-05', description: 'POS', amountKobo: '-1845000' },
        { date: '5 Oct', description: 'bad date', amountKobo: '1' },
        { date: '2026-10-06', description: 'bad amount', amountKobo: '1.5' },
      ],
    });
    const ai = new AiService([claude], workspaces({ statements: true }));
    const rows = await ai.readStatement(ctx, '05/10/2026 POS 18,450.00 793,850.00', ['Ada']);
    expect(rows).toEqual([{ date: '2026-10-05', description: 'POS', amountMinor: -1_845_000n }]);
  });
});
