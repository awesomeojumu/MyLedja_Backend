export function normalizeDescription(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

export function resolveMerchant<T extends { aliases: string[]; name: string }>(
  description: string,
  merchants: readonly T[],
): T | undefined {
  const hay = normalizeDescription(description);
  let best: { row: T; len: number } | undefined;
  for (const row of merchants) {
    for (const alias of row.aliases) {
      const needle = normalizeDescription(alias);
      if (needle && hay.includes(needle) && (!best || needle.length > best.len)) {
        best = { row, len: needle.length };
      }
    }
  }
  return best?.row;
}
