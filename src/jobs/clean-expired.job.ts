import type { RateLimitRepository } from '../common/http/rate-limit.repository.js';
import type { CodesRepository, SessionsRepository } from '../modules/auth/auth.repository.js';
import type { JobHandler } from './runner.js';

const REVOKED_KEPT_MS = 30 * 86_400_000;

/**
 * Hourly: removes expired codes and rate-limit entries, and sessions revoked more than 30 days ago
 * (MongoDB's TTL indexes also remove expired ones; this catches what they leave).
 */
export function cleanExpiredJob(deps: {
  sessions: SessionsRepository;
  codes: CodesRepository;
  limits: RateLimitRepository;
}): JobHandler {
  return {
    name: 'clean-expired',
    everySeconds: 3600,
    async run() {
      const now = new Date();
      await deps.codes.deleteExpired(now);
      await deps.limits.deleteExpired(now);
      await deps.sessions.deleteRevokedBefore(new Date(now.getTime() - REVOKED_KEPT_MS));
    },
  };
}
