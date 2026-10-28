import { type AppConfig, parseConfig } from '../../src/config/config.schema.js';

/** Test values written here, never read from a real .env file (build plan 2.5). */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({
    APP_ENV: 'development',
    APP_URL: 'http://localhost:4000',
    CORS_ORIGINS: 'http://localhost:8081',
    JWT_SECRET: 'test-only-jwt-secret-0123456789abcdef',
    ACCOUNT_NUMBER_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    MONGODB_URI: 'mongodb://127.0.0.1:1/unused',
    MONGODB_DB: 'myledja_test',
    ...overrides,
  });
}
