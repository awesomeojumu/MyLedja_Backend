const VERCEL_APP = /^https:\/\/myledja-(web|app)(-[a-z0-9-]+)?\.vercel\.app$/;
const PRODUCTION_HOSTS = new Set(["https://app.myledja.com"]);

export function isAllowedCorsOrigin(origin: string, extra: readonly string[]): boolean {
  return extra.includes(origin) || PRODUCTION_HOSTS.has(origin) || VERCEL_APP.test(origin);
}
