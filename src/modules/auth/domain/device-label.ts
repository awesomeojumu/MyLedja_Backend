export function deviceLabelFromUa(ua?: string | null): string {
  const raw = (ua ?? "").trim();
  if (!raw) return "This device";
  if (/mobile|android|iphone|ipad/i.test(raw)) return "This phone";
  return "This browser";
}
