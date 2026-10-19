export function isAllowedCorsOrigin(origin: string, extra: readonly string[]): boolean {
  return extra.includes(origin);
}
