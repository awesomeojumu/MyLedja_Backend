import { parseMinor, percentOf } from '../../common/money/money.js';
import type { IncomeStreamDoc } from './income.repository.js';

export type GrossSplit = {
  gross: string;
  takeHome: string;
  paye: string;
  pension: string;
  nhf: string;
  pensionAccountId: string;
  nhfAccountId: string;
};

function deductionMinor(
  d: { amount?: string; percentBasisPoints?: number; label: string },
  gross: bigint,
  want: 'paye' | 'pension' | 'nhf',
): bigint {
  const label = d.label.toLowerCase();
  const match =
    want === 'paye'
      ? label.includes('paye') || label.includes('tax')
      : want === 'pension'
        ? label.includes('pension')
        : label.includes('nhf');
  if (!match) return 0n;
  if (d.amount) return parseMinor(d.amount);
  if (d.percentBasisPoints !== undefined) return percentOf(gross, BigInt(d.percentBasisPoints));
  return 0n;
}

/** E24 parts from a gross income stream, or null when incomplete. */
export function grossSplitFromStream(doc: IncomeStreamDoc): GrossSplit | null {
  if (doc.recordAs !== 'gross' || !doc.grossAmountMinor) return null;
  const gross = parseMinor(doc.grossAmountMinor);
  if (gross <= 0n) return null;
  let paye = 0n;
  let pension = 0n;
  let nhf = 0n;
  let pensionAccountId: string | null = null;
  let nhfAccountId: string | null = null;
  for (const d of doc.deductions) {
    paye += deductionMinor(d, gross, 'paye');
    const p = deductionMinor(d, gross, 'pension');
    if (p > 0n) {
      pension += p;
      if (d.ledgerAccountId) pensionAccountId = d.ledgerAccountId;
    }
    const n = deductionMinor(d, gross, 'nhf');
    if (n > 0n) {
      nhf += n;
      if (d.ledgerAccountId) nhfAccountId = d.ledgerAccountId;
    }
  }
  if (!pensionAccountId || !nhfAccountId) return null;
  const takeHome = gross - paye - pension - nhf;
  if (takeHome <= 0n) return null;
  return {
    gross: doc.grossAmountMinor,
    takeHome: takeHome.toString(),
    paye: paye.toString(),
    pension: pension.toString(),
    nhf: nhf.toString(),
    pensionAccountId,
    nhfAccountId,
  };
}
