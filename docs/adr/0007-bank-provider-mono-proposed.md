# ADR-0007: Bank provider — Mono primary (DEC-08)

- Status: Proposed
- Date: 2026-10-17
- Spec: §8.3, DEC-08

## Context

Bank aggregation is gated (CON-12). Sandbox and KYB take 4–6 weeks. §8.3 excludes screen scraping. Okra wound down May 2025.

## Options

| Option | For | Against |
|---|---|---|
| **A. Mono primary** | Nigerian coverage, existing link code | KYB lead time, licensing still with counsel |
| B. Stitch primary | Strong SA open banking | NG scrape status unconfirmed — §8.3 risk |
| C. Wait for NIBSS AIS only | Cleanest licence story | Blocks product discovery |

## Decision (proposed)

**Option A** once sandbox coverage and counsel return. Stitch stays fallback only if the NG path is not scrape. Okra is out.

This ADR stays **Proposed** until `docs/external-dependencies.md` has Mono sandbox and KYB application IDs and a counsel reply date.

## Consequences

- Do not expand live Mono link work until Proposed → Accepted.
- Manual accounts ship without a live aggregator.
