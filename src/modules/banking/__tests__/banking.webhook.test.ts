import { describe, expect, it } from 'vitest';
import { Crypto } from '../../../common/crypto/crypto.js';
import type { JobRunner } from '../../../jobs/runner.js';
import type { AuditRepository } from '../../audit/audit.repository.js';
import type { ImportsService } from '../../imports/imports.service.js';
import type { BankLinkIndex, BankLinksRepository } from '../banking.repository.js';
import { BankingService } from '../banking.service.js';

const crypto = new Crypto('a'.repeat(64));

function service(secret: string | null) {
  const queued: Record<string, string>[] = [];
  const index = {
    byProviderHash: async (hash: string) =>
      hash === crypto.hash('token-hash', 'mono-acc-1') ? { _id: 'link-1', workspaceId: 'ws-1' } : null,
  } as unknown as BankLinkIndex;
  const jobs = {
    enqueue: async (_n: string, _at: Date, _m: number, payload: Record<string, string>) => void queued.push(payload),
  } as unknown as JobRunner;
  const s = new BankingService(
    null,
    secret,
    {} as BankLinksRepository,
    index,
    {} as ImportsService,
    crypto,
    {} as AuditRepository,
    jobs,
  );
  return { s, queued };
}

describe('Mono webhook (B4.6)', () => {
  it('is refused without the secret, with a wrong one, or when no secret is set', async () => {
    await expect(service('s3cret').s.webhook(undefined, {})).rejects.toMatchObject({ code: 'webhook_refused' });
    await expect(service('s3cret').s.webhook('wrong!', {})).rejects.toMatchObject({ code: 'webhook_refused' });
    await expect(service(null).s.webhook('anything', {})).rejects.toMatchObject({ code: 'webhook_refused' });
  });

  it('queues a sync for the linked account when the secret matches', async () => {
    const { s, queued } = service('s3cret');
    await s.webhook('s3cret', { event: 'mono.events.account_updated', data: { account: { _id: 'mono-acc-1' } } });
    expect(queued).toEqual([{ workspaceId: 'ws-1', linkId: 'link-1' }]);
  });
});
