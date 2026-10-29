import { divRoundHalfAwayFromZero } from '../../common/money/money.js';

/**
 * "Formula" report cards (DESIGN.md page 19): a number from the person's own formula, such as
 * `income - spending` or `spending / income`. Exact: every value is a fraction of bigints, never a float.
 * Money variables are minor units; a plain number next to money in + or − is naira ("spending - 5000"),
 * and a plain number in × or ÷ is a factor ("spending / 2").
 */

export const FORMULA_VARIABLES = ['income', 'spending', 'net', 'assets', 'debts', 'net_worth'] as const;
export type FormulaVariable = (typeof FORMULA_VARIABLES)[number];

export class FormulaError extends Error {
  constructor(
    readonly reason: 'syntax' | 'unknown_name' | 'units' | 'divide_by_zero',
    readonly at: number,
  ) {
    super(`formula_${reason}`);
    this.name = 'FormulaError';
  }
}

/** A value: num ÷ den, with `money` 1 for an amount and 0 for a plain number or a ratio. */
type Value = { num: bigint; den: bigint; money: 0 | 1 };

type Token = { kind: 'num' | 'name' | 'op' | 'open' | 'close'; text: string; at: number };

function tokens(src: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([a-z_]+)|([+\-*/×÷])|(\()|(\)))/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(at))) break;
      throw new FormulaError('syntax', at);
    }
    const pos = m.index + m[0].length - (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').length;
    if (m[1]) out.push({ kind: 'num', text: m[1], at: pos });
    else if (m[2]) out.push({ kind: 'name', text: m[2], at: pos });
    else if (m[3]) out.push({ kind: 'op', text: m[3] === '×' ? '*' : m[3] === '÷' ? '/' : m[3], at: pos });
    else if (m[4]) out.push({ kind: 'open', text: '(', at: pos });
    else out.push({ kind: 'close', text: ')', at: pos });
    at = re.lastIndex;
  }
  return out;
}

const scalar = (text: string): Value => {
  const [whole, frac = ''] = text.split('.');
  return { num: BigInt(whole! + frac), den: 10n ** BigInt(frac.length), money: 0 };
};

/** A plain number in money arithmetic is naira: 5000 is ₦5,000.00. */
const asMoney = (v: Value, exponent: number): Value =>
  v.money ? v : { num: v.num * 10n ** BigInt(exponent), den: v.den, money: 1 };

/**
 * Evaluates the formula. Returns minor units for an amount, or basis points for a ratio (spending ÷ income
 * is 7400 for 74%), rounded half away from zero.
 */
export function evaluate(
  src: string,
  vars: Record<FormulaVariable, bigint>,
  exponent = 2,
): { unit: 'money' | 'basis_points'; value: bigint } {
  const toks = tokens(src.toLowerCase());
  let i = 0;
  const peek = () => toks[i];
  const fail = (reason: FormulaError['reason']) => {
    throw new FormulaError(reason, peek()?.at ?? src.length);
  };

  const primary = (): Value => {
    const t = toks[i++];
    if (!t) return fail('syntax');
    if (t.kind === 'num') return scalar(t.text);
    if (t.kind === 'name') {
      if (!(FORMULA_VARIABLES as readonly string[]).includes(t.text)) throw new FormulaError('unknown_name', t.at);
      return { num: vars[t.text as FormulaVariable], den: 1n, money: 1 };
    }
    if (t.kind === 'op' && t.text === '-') {
      const v = primary();
      return { ...v, num: -v.num };
    }
    if (t.kind === 'open') {
      const v = sum();
      if (toks[i++]?.kind !== 'close') fail('syntax');
      return v;
    }
    return fail('syntax');
  };

  const product = (): Value => {
    let left = primary();
    while (peek()?.kind === 'op' && (peek()!.text === '*' || peek()!.text === '/')) {
      const op = toks[i++]!.text;
      const right = primary();
      if (op === '*') {
        if (left.money + right.money > 1) fail('units');
        left = { num: left.num * right.num, den: left.den * right.den, money: (left.money + right.money) as 0 | 1 };
      } else {
        if (right.num === 0n) fail('divide_by_zero');
        if (right.money > left.money) fail('units');
        left = { num: left.num * right.den, den: left.den * right.num, money: (left.money - right.money) as 0 | 1 };
      }
    }
    return left;
  };

  const sum = (): Value => {
    let left = product();
    while (peek()?.kind === 'op' && (peek()!.text === '+' || peek()!.text === '-')) {
      const op = toks[i++]!.text;
      let right = product();
      if (left.money !== right.money) {
        left = asMoney(left, exponent);
        right = asMoney(right, exponent);
      }
      const num = left.num * right.den + (op === '+' ? 1n : -1n) * right.num * left.den;
      left = { num, den: left.den * right.den, money: left.money };
    }
    return left;
  };

  const result = sum();
  if (i !== toks.length) fail('syntax');
  return result.money
    ? { unit: 'money', value: divRoundHalfAwayFromZero(result.num, result.den) }
    : { unit: 'basis_points', value: divRoundHalfAwayFromZero(result.num * 10_000n, result.den) };
}
