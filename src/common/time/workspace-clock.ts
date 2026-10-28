/** Calendar date (YYYY-MM-DD) for an instant in an IANA time zone. */
export function localDateString(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function localClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

/** Adds whole calendar days to an ISO date string (UTC-safe arithmetic). */
export function addCalendarDays(iso: string, delta: number): string {
  const [ys, ms, ds] = iso.split('-');
  const y = parseInt(ys!, 10);
  const m = parseInt(ms!, 10);
  const d = parseInt(ds!, 10);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
