import { describe, expect, it } from 'vitest';
import { newBackupCodes, newTotpSecret, totpAt, verifyTotp } from '../totp.js';

describe('two-factor codes (B3.1)', () => {
  // RFC 6238 test secret "12345678901234567890" in base32; at 59 s the 8-digit code is 94287082.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches the RFC 6238 test vector', () => {
    expect(totpAt(RFC_SECRET, 59)).toBe('287082');
  });

  it('accepts the code for now and one step either side, and nothing else', () => {
    const secret = newTotpSecret();
    const now = new Date('2026-10-28T12:00:00Z');
    const t = now.getTime() / 1000;
    expect(verifyTotp(secret, totpAt(secret, t), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t - 30), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, t + 90), now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });

  it('makes ten distinct backup codes', () => {
    const codes = newBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
  });
});
