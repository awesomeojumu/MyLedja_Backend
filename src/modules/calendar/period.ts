export function monthEnd(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function clampDay(year: number, month: number, day: number): Date {
  const last = monthEnd(year, month);
  return new Date(Date.UTC(year, month, Math.min(day, last)));
}

export function nextMonthly(from: Date, anchorDay: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const candidate = clampDay(year, month, anchorDay);
  if (candidate.getTime() >= Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) {
    return candidate;
  }
  const next = month === 11 ? { y: year + 1, m: 0 } : { y: year, m: month + 1 };
  return clampDay(next.y, next.m, anchorDay);
}

export function weekBounds(now: Date, weekStartsOn: "monday" | "sunday"): { from: Date; to: Date } {
  const day = now.getUTCDay();
  const startOffset = weekStartsOn === "sunday" ? day : (day + 6) % 7;
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - startOffset));
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  return { from, to };
}

export function zonedInstant(at: Date, timezone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
    return new Date(Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second")));
  } catch {
    return at;
  }
}

export function inLagosOctober(iso: string): boolean {
  return zonedInstant(new Date(iso), "Africa/Lagos").getUTCMonth() === 9;
}
