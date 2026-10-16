# ADR-0001: Money is stored as integer minor units (DEC-02)

- Status: Accepted
- Date: 2026-10-15
- Story: MYL-003
- Spec: §5.3, DEC-02

## Context

Spec §5.3 requires one canonical money representation: either MongoDB Decimal128 or integer minor units with an explicit currency scale, never a mixture. API values are decimal strings and every amount carries its currency.

## Decision

Every amount is a pair of an **integer count of minor units** (kobo for NGN, cents for USD) and an **ISO 4217 currency code**.

- **Storage:** MongoDB `int64` (`Long`). The driver runs with `useBigInt64: true`, so values come back as `bigint`.
- **In code:** the `Money` type in `src/common/money`. It holds `amountMinor: bigint` and `currency`. JavaScript `number` is never used for amounts, and the library refuses `number` input.
- **API:** amounts are decimal strings such as `"1234.50"` next to a `currency` field. The string must not have more decimal places than the currency's scale. Extra precision is rejected, not rounded silently.
- **Scale:** each currency's scale comes from the table in `src/common/money/currencies.ts`: NGN, USD, EUR and GBP use 2, JPY uses 0, KWD uses 3. Unknown currencies are rejected.
- **Rounding:** an operation that can leave a fraction of a minor unit (multiplying by a rate or percentage) needs a rounding mode. The default is **half-even** (banker's rounding). `half-up`, `floor` and `ceil` are also available for rules that need them, for example a fee that rounds up.
- **Allocation:** splitting an amount (splits, instalments) uses largest-remainder allocation, so the parts always add up to the original exactly (INV-05).
- **Currency mismatch:** adding, subtracting or comparing two different currencies throws `CurrencyMismatchError`. Multi-currency totals go through an explicit conversion with a recorded rate (INV-20).
- **Range:** values must fit in a signed 64-bit integer. Overflow throws.

## Consequences

- Arithmetic is exact and quick. Sums and indexes work natively on `int64`.
- A currency's scale must never change once data exists. Adding a new currency means adding a row to the table.
- Exchange rates and percentages are decimal strings in rate math, never floats.
- Decimal128 was rejected. It is a floating-point decimal with no fixed scale, so `1.5` and `1.50` can sit side by side, and JavaScript has no native arithmetic for it.
