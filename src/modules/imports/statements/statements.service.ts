import type { z } from 'zod';
import { AppError } from '../../../common/errors/errors.js';
import { newId } from '../../../common/ids/ids.js';
import type { WorkspaceContext } from '../../../common/workspace/workspace-context.js';
import type { AiService } from '../../ai/ai.service.js';
import type { UsersRepository } from '../../auth/auth.repository.js';
import type { CategoriesRepository } from '../../categories/categories.repository.js';
import type { FileStore } from '../../files/cloudinary.js';
import type { Import } from '../imports.contract.js';
import type { ImportsService } from '../imports.service.js';
import { detectBank, excelGrid, type ParsedRow, pdfText, rowsFromGrid, rowsFromText } from './parse.js';

const MESSAGES = {
  unreadable:
    "MyLedja couldn't find transactions in this statement. Turn on AI statement reading in Settings, or upload a CSV.",
  kind: 'Upload a PDF or Excel (.xlsx) statement.',
} as const;

const toText = (minor: bigint) => {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * PDF and Excel statements (build plan B4.2, B4.3, F4.1). The file is read on the server without AI where the layout
 * allows; otherwise, with consent, by AI from redacted lines. Either way the rows go through the same review as a CSV.
 */
export class StatementsService {
  constructor(
    private readonly imports: ImportsService,
    private readonly ai: AiService,
    private readonly users: UsersRepository,
    private readonly categories: CategoriesRepository,
    private readonly files: FileStore | null,
  ) {}

  async upload(
    ctx: WorkspaceContext,
    body: { id?: string | undefined; accountId: string; fileName: string; fileBase64: string; useAi: boolean },
  ): Promise<z.input<typeof Import> & { reader: 'parser' | 'ai'; bank: string | null }> {
    const content = Buffer.from(body.fileBase64, 'base64');
    const isPdf = content.subarray(0, 4).toString() === '%PDF';
    const isXlsx = content.subarray(0, 2).toString() === 'PK';
    if (!isPdf && !isXlsx) throw new AppError(400, 'statement_kind', MESSAGES.kind, { field: 'fileBase64' });

    const grid = isPdf ? null : await excelGrid(content);
    const text = grid ? grid.map((r) => r.join(' ')).join('\n') : await pdfText(content);
    let rows: ParsedRow[] = grid ? rowsFromGrid(grid) : rowsFromText(text);
    let reader: 'parser' | 'ai' = 'parser';
    if (rows.length === 0 && body.useAi) {
      const user = ctx.userId ? await this.users.byId(ctx.userId) : null;
      rows = await this.ai.readStatement(ctx, text, user ? [user.name] : []);
      reader = 'ai';
    }
    if (rows.length === 0)
      throw new AppError(400, 'statement_unreadable', MESSAGES.unreadable, { field: 'fileBase64' });

    const id = body.id ?? newId();
    // The original file is kept private; only signed links open it (TECH-SPEC 5.8).
    if (this.files)
      await this.files.upload(`workspaces/${ctx.workspaceId}/statements/${id}`, content).catch(() => null);

    const csv = [
      'Date,Description,Amount',
      ...rows.map((r) => [r.date, csvCell(r.description), toText(r.amountMinor)].join(',')),
    ].join('\n');
    await this.imports.upload(ctx, { id, accountId: body.accountId, fileName: body.fileName, content: csv });
    let view = await this.imports.map(ctx, id, {
      date: 0,
      description: 1,
      amount: 2,
      moneyIn: null,
      moneyOut: null,
      payee: null,
      notes: null,
      dateFormat: 'YYYY-MM-DD',
      hasHeader: true,
    });

    // Suggested categories for rows without one, when the person has agreed to AI categorizing (B4.4).
    const consent = await this.ai.consent(ctx);
    const open = view.rows.filter((r) => !r.categoryId && !r.error && r.amount !== null);
    if (consent.categorize && open.length) {
      const cats = (await this.categories.live(ctx)).filter((c) => !c.system);
      const picks = await this.ai
        .categorize(
          ctx,
          open.map((r) => ({
            description: r.description,
            amountMinor: BigInt(String(r.amount)),
            date: String(r.date),
          })),
          cats.map((c) => ({ id: c._id, name: c.name, kind: c.kind })),
        )
        .catch(() => [] as (string | null)[]);
      const byIndex = new Map<number, string>();
      picks.forEach((p, i) => p && byIndex.set(open[i]!.index, p));
      view = await this.imports.suggestCategories(ctx, id, byIndex);
    }
    return { ...view, reader, bank: detectBank(text) };
  }
}
