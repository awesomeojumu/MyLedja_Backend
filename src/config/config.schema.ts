import { z } from 'zod';

export const APP_ENVS = ['development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Every backend variable of TECH-SPEC 2.1, by its exact name. */
export const VARIABLE_NAMES = [
  'APP_ENV',
  'PORT',
  'APP_URL',
  'TRUST_PROXY',
  'CORS_ORIGINS',
  'JWT_SECRET',
  'ACCOUNT_NUMBER_KEY',
  'MONGODB_URI',
  'MONGODB_DB',
  'DNS_SERVERS',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'CONTACT_EMAIL',
  'MONO_SEC_KEY',
  'MONO_PUBLIC_KEY',
  'MONO_APP_ID',
  // Optional (TECH-SPEC 2.3 rule 4): the webhook secret set in Mono's dashboard. Unset, every webhook is refused.
  'MONO_WEBHOOK_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_FOLDER',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  // Optional (TECH-SPEC 2.3 rule 4): "true" once the Gemini key is confirmed on a paid plan (TECH-SPEC 5.8).
  'GOOGLE_GEMINI_PAID_PLAN',
] as const;
export type VariableName = (typeof VARIABLE_NAMES)[number];

/** Needed to run at all, in every environment. */
const ALWAYS_REQUIRED: VariableName[] = ['JWT_SECRET', 'ACCOUNT_NUMBER_KEY', 'MONGODB_URI'];
/** Also needed in staging and production (TECH-SPEC 2.3 rule 2). */
const DEPLOYED_REQUIRED: VariableName[] = ['APP_URL', 'CORS_ORIGINS', 'MONGODB_DB'];

export const JWT_SECRET_MIN_LENGTH = 32;

type Check = { test: (v: string) => boolean; problem: string };

const CHECKS: Partial<Record<VariableName, Check>> = {
  APP_ENV: {
    test: (v) => (APP_ENVS as readonly string[]).includes(v),
    problem: 'must be development, staging or production',
  },
  PORT: { test: (v) => /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536, problem: 'must be a port number' },
  APP_URL: { test: isHttpUrl, problem: 'must be an http or https address' },
  TRUST_PROXY: { test: (v) => /^(0|1|true|false|\d+)$/.test(v), problem: 'must be 0, 1, true, false or a hop count' },
  CORS_ORIGINS: {
    test: (v) => splitList(v).every(isHttpUrl),
    problem: 'must be comma-separated http or https origins',
  },
  JWT_SECRET: {
    test: (v) => v.length >= JWT_SECRET_MIN_LENGTH,
    problem: `must be at least ${JWT_SECRET_MIN_LENGTH} characters`,
  },
  ACCOUNT_NUMBER_KEY: { test: (v) => /^[0-9a-fA-F]{64}$/.test(v), problem: 'must be 64 hex characters (32 bytes)' },
  MONGODB_URI: {
    test: (v) => /^mongodb(\+srv)?:\/\/.+/.test(v),
    problem: 'must be a mongodb:// or mongodb+srv:// address',
  },
  DNS_SERVERS: { test: (v) => splitList(v).length > 0, problem: 'must be comma-separated DNS server addresses' },
  SMTP_PORT: { test: (v) => /^\d{1,5}$/.test(v), problem: 'must be a port number' },
};

export class ConfigError extends Error {
  constructor(readonly problems: { name: VariableName; problem: string }[]) {
    super(
      'MyLedja cannot start. Fix these environment variables:\n' +
        problems.map((p) => `  ${p.name} ${p.problem}`).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

export const configSchema = z.object({
  appEnv: z.enum(APP_ENVS),
  port: z.number().int(),
  appUrl: z.string(),
  trustProxy: z.union([z.boolean(), z.number().int()]),
  corsOrigins: z.array(z.string()),
  jwtSecret: z.string(),
  accountNumberKey: z.string(),
  mongodbUri: z.string(),
  mongodbDb: z.string(),
  dnsServers: z.array(z.string()),
  contactEmail: z.string().nullable(),
  email: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('resend'), apiKey: z.string(), from: z.string() }),
    z.object({
      provider: z.literal('smtp'),
      host: z.string(),
      port: z.number().int(),
      user: z.string().nullable(),
      pass: z.string().nullable(),
      from: z.string(),
    }),
    z.object({ provider: z.literal('off') }),
  ]),
  mono: z
    .object({
      secretKey: z.string(),
      publicKey: z.string(),
      appId: z.string().nullable(),
      webhookSecret: z.string().nullable(),
    })
    .nullable(),
  cloudinary: z
    .object({ cloudName: z.string(), apiKey: z.string(), apiSecret: z.string(), folder: z.string().nullable() })
    .nullable(),
  google: z.object({ clientId: z.string(), clientSecret: z.string().nullable() }).nullable(),
  anthropicApiKey: z.string().nullable(),
  geminiApiKey: z.string().nullable(),
  geminiPaidPlan: z.boolean(),
});
export type AppConfig = z.infer<typeof configSchema>;

/** Optional outside services report "on" or "off" by whether their variables are set (TECH-SPEC 2.3 rule 3). */
export function serviceStatus(config: AppConfig) {
  const onOff = (on: boolean) => (on ? 'on' : 'off');
  return {
    email: config.email.provider,
    mono: onOff(config.mono !== null),
    cloudinary: onOff(config.cloudinary !== null),
    google: onOff(config.google !== null),
    claude: onOff(config.anthropicApiKey !== null),
    gemini: onOff(config.geminiApiKey !== null),
  };
}

/**
 * Reads and checks the environment. Error text names the variable and the rule it breaks, never the value.
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const get = (name: VariableName): string | null => {
    const v = env[name]?.trim();
    return v ? v : null;
  };
  const problems: { name: VariableName; problem: string }[] = [];

  const appEnvRaw = get('APP_ENV') ?? 'development';
  const appEnvCheck = CHECKS.APP_ENV!;
  if (!appEnvCheck.test(appEnvRaw)) {
    throw new ConfigError([{ name: 'APP_ENV', problem: appEnvCheck.problem }]);
  }
  const appEnv = appEnvRaw as AppEnv;
  const deployed = appEnv !== 'development';

  const required = deployed ? [...ALWAYS_REQUIRED, ...DEPLOYED_REQUIRED] : ALWAYS_REQUIRED;
  for (const name of required) {
    if (get(name) === null) problems.push({ name, problem: 'is missing' });
  }
  for (const [name, check] of Object.entries(CHECKS) as [VariableName, Check][]) {
    const v = get(name);
    if (v !== null && !check.test(v)) problems.push({ name, problem: check.problem });
  }

  const pairs: [VariableName, VariableName][] = [
    ['RESEND_API_KEY', 'RESEND_FROM'],
    ['MONO_SEC_KEY', 'MONO_PUBLIC_KEY'],
  ];
  for (const [a, b] of pairs) {
    if ((get(a) === null) !== (get(b) === null)) {
      const missing = get(a) === null ? a : b;
      problems.push({ name: missing, problem: `is missing; it's needed with ${missing === a ? b : a}` });
    }
  }
  if (get('SMTP_HOST') !== null && get('SMTP_FROM') === null && get('RESEND_API_KEY') === null) {
    problems.push({ name: 'SMTP_FROM', problem: "is missing; it's needed with SMTP_HOST" });
  }
  const cloudinary = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const;
  const cloudinarySet = cloudinary.filter((n) => get(n) !== null);
  if (cloudinarySet.length > 0 && cloudinarySet.length < cloudinary.length) {
    for (const n of cloudinary) {
      if (get(n) === null) problems.push({ name: n, problem: 'is missing; Cloudinary needs all three keys' });
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const trustProxyRaw = get('TRUST_PROXY');
  const trustProxy =
    trustProxyRaw === null || trustProxyRaw === '0' || trustProxyRaw === 'false'
      ? false
      : trustProxyRaw === 'true'
        ? true
        : Number(trustProxyRaw);

  const resendKey = get('RESEND_API_KEY');
  const smtpHost = get('SMTP_HOST');
  const email: AppConfig['email'] = resendKey
    ? { provider: 'resend', apiKey: resendKey, from: get('RESEND_FROM')! }
    : smtpHost
      ? {
          provider: 'smtp',
          host: smtpHost,
          port: Number(get('SMTP_PORT') ?? '465'),
          user: get('SMTP_USER'),
          pass: get('SMTP_PASS'),
          from: get('SMTP_FROM')!,
        }
      : { provider: 'off' };

  const monoKey = get('MONO_SEC_KEY');
  const googleId = get('GOOGLE_CLIENT_ID');

  return configSchema.parse({
    appEnv,
    port: Number(get('PORT') ?? '4000'),
    appUrl: get('APP_URL') ?? 'http://localhost:4000',
    trustProxy,
    corsOrigins: splitList(get('CORS_ORIGINS') ?? (deployed ? '' : 'http://localhost:8081')),
    jwtSecret: get('JWT_SECRET')!,
    accountNumberKey: get('ACCOUNT_NUMBER_KEY')!.toLowerCase(),
    mongodbUri: get('MONGODB_URI')!,
    mongodbDb: get('MONGODB_DB') ?? 'MyLedja',
    dnsServers: splitList(get('DNS_SERVERS') ?? ''),
    contactEmail: get('CONTACT_EMAIL'),
    email,
    mono: monoKey
      ? {
          secretKey: monoKey,
          publicKey: get('MONO_PUBLIC_KEY')!,
          appId: get('MONO_APP_ID'),
          webhookSecret: get('MONO_WEBHOOK_SECRET'),
        }
      : null,
    cloudinary:
      cloudinarySet.length === cloudinary.length
        ? {
            cloudName: get('CLOUDINARY_CLOUD_NAME')!,
            apiKey: get('CLOUDINARY_API_KEY')!,
            apiSecret: get('CLOUDINARY_API_SECRET')!,
            folder: get('CLOUDINARY_FOLDER'),
          }
        : null,
    google: googleId ? { clientId: googleId, clientSecret: get('GOOGLE_CLIENT_SECRET') } : null,
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
    geminiApiKey: get('GOOGLE_GEMINI_API_KEY'),
    geminiPaidPlan: get('GOOGLE_GEMINI_PAID_PLAN') === 'true',
  });
}

function splitList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
