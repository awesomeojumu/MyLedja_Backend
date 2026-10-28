import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, serviceStatus } from '../config.schema.js';

const KEY = 'a'.repeat(64);
const SECRET = 's'.repeat(40);

const staging = {
  APP_ENV: 'staging',
  APP_URL: 'https://api.staging.example.test',
  CORS_ORIGINS: 'https://web.example.test',
  JWT_SECRET: SECRET,
  ACCOUNT_NUMBER_KEY: KEY,
  MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.test',
  MONGODB_DB: 'MyLedja',
};

function problemsOf(env: Record<string, string>) {
  try {
    parseConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error('expected parseConfig to refuse');
}

describe('config (TECH-SPEC 2.3)', () => {
  it('accepts a complete staging environment', () => {
    const c = parseConfig(staging);
    expect(c.appEnv).toBe('staging');
    expect(c.corsOrigins).toEqual(['https://web.example.test']);
  });

  it('refuses to start in production when JWT_SECRET is missing', () => {
    const { JWT_SECRET: _, ...env } = { ...staging, APP_ENV: 'production' };
    const e = problemsOf(env);
    expect(e.problems).toContainEqual({ name: 'JWT_SECRET', problem: 'is missing' });
  });

  it('refuses a JWT_SECRET that is too short', () => {
    const e = problemsOf({ ...staging, JWT_SECRET: 'short-secret-value' });
    expect(e.problems.map((p) => p.name)).toEqual(['JWT_SECRET']);
  });

  it('refuses an ACCOUNT_NUMBER_KEY that is not 64 hex characters', () => {
    expect(problemsOf({ ...staging, ACCOUNT_NUMBER_KEY: 'z'.repeat(64) }).problems[0]?.name).toBe('ACCOUNT_NUMBER_KEY');
    expect(problemsOf({ ...staging, ACCOUNT_NUMBER_KEY: 'ab12' }).problems[0]?.name).toBe('ACCOUNT_NUMBER_KEY');
  });

  it('refuses a MONGODB_URI that is not a MongoDB address', () => {
    expect(problemsOf({ ...staging, MONGODB_URI: 'postgres://x' }).problems[0]?.name).toBe('MONGODB_URI');
  });

  it('needs APP_URL, CORS_ORIGINS and MONGODB_DB outside development', () => {
    const { APP_URL: _a, CORS_ORIGINS: _c, MONGODB_DB: _d, ...env } = staging;
    expect(
      problemsOf(env)
        .problems.map((p) => p.name)
        .sort(),
    ).toEqual(['APP_URL', 'CORS_ORIGINS', 'MONGODB_DB']);
  });

  it('allows development without the deployed-only variables', () => {
    const c = parseConfig({ JWT_SECRET: SECRET, ACCOUNT_NUMBER_KEY: KEY, MONGODB_URI: 'mongodb://localhost' });
    expect(c.appEnv).toBe('development');
    expect(c.port).toBe(4000);
    expect(c.corsOrigins).toEqual(['http://localhost:8081']);
  });

  it('still needs ACCOUNT_NUMBER_KEY in development (build plan 2.5)', () => {
    const e = problemsOf({ JWT_SECRET: SECRET, MONGODB_URI: 'mongodb://localhost' });
    expect(e.problems).toEqual([{ name: 'ACCOUNT_NUMBER_KEY', problem: 'is missing' }]);
  });

  it('marks Mono, Cloudinary, Google and AI off when unset', () => {
    expect(serviceStatus(parseConfig(staging))).toEqual({
      email: 'off',
      mono: 'off',
      cloudinary: 'off',
      google: 'off',
      claude: 'off',
      gemini: 'off',
    });
  });

  it('turns services on when their variables are set, and prefers Resend over SMTP', () => {
    const c = parseConfig({
      ...staging,
      MONO_SEC_KEY: 'live_sk',
      MONO_PUBLIC_KEY: 'live_pk',
      RESEND_API_KEY: 're_x',
      RESEND_FROM: 'MyLedja <help@myledja.test>',
      SMTP_HOST: 'smtp.example.test',
      SMTP_FROM: 'help@myledja.test',
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    });
    expect(serviceStatus(c)).toMatchObject({ email: 'resend', mono: 'on', google: 'on' });
  });

  it('uses SMTP when Resend is not set', () => {
    const c = parseConfig({ ...staging, SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'help@myledja.test' });
    expect(c.email).toMatchObject({ provider: 'smtp', port: 465 });
  });

  it('refuses half-set service pairs', () => {
    expect(problemsOf({ ...staging, MONO_SEC_KEY: 'sk' }).problems[0]?.name).toBe('MONO_PUBLIC_KEY');
    expect(problemsOf({ ...staging, CLOUDINARY_CLOUD_NAME: 'c' }).problems.map((p) => p.name)).toEqual([
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ]);
  });

  it('refuses an unknown APP_ENV', () => {
    expect(problemsOf({ ...staging, APP_ENV: 'prod' }).problems[0]?.name).toBe('APP_ENV');
  });

  it('never puts a value in the error text', () => {
    const secretValues = ['short-secret-value', 'nothex-'.repeat(9) + 'x', 'postgres://user:hunter2@db'];
    const e = problemsOf({
      ...staging,
      JWT_SECRET: secretValues[0]!,
      ACCOUNT_NUMBER_KEY: secretValues[1]!,
      MONGODB_URI: secretValues[2]!,
    });
    for (const v of secretValues) expect(e.message).not.toContain(v);
    expect(e.message).toContain('JWT_SECRET');
  });

  it('reads TRUST_PROXY as a boolean or hop count', () => {
    expect(parseConfig({ ...staging, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(parseConfig({ ...staging, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(parseConfig({ ...staging }).trustProxy).toBe(false);
  });
});
