/** Display name for Mono when the user record has none. Never send the raw email as the name. */
export function customerNameFromEmail(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  return local.length > 0 ? local : "MyLedja user";
}

export function linkReference(workspaceId: string, now: Date = new Date()): string {
  const compact = workspaceId.replace(/-/g, "").slice(0, 12);
  return `myl${compact}${now.getTime()}`;
}
