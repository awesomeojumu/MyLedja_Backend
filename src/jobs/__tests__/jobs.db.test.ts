import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from '../../modules/notifications/email/email.js';
import { Outbox, startTestApp, type TestApp } from '../../../test/helpers/test-app.js';
import { JobsRepository } from '../jobs.repository.js';
import { JobRunner } from '../runner.js';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

function runner(outbox = new Outbox(), now = () => t.clock.now) {
  return new JobRunner(new JobsRepository(t.db), new Mailer(outbox, 'http://localhost:8081'), 'ops@myledja.test', now);
}

describe('jobs runner (B0.10, TECH-SPEC 5.6)', () => {
  it('two runners never take the same job', async () => {
    const ran: string[] = [];
    const runners = Array.from({ length: 4 }, () => runner());
    for (const r of runners) {
      r.register({
        name: 'count',
        async run(job) {
          ran.push(job._id);
          await new Promise((res) => setTimeout(res, 5));
        },
      });
    }
    for (let i = 0; i < 10; i++) await runners[0]!.enqueue('count', t.clock.now);
    await Promise.all(
      runners.map(async (r) => {
        while (await r.tick()) {
          // keep draining
        }
      }),
    );
    expect(ran).toHaveLength(10);
    expect(new Set(ran).size).toBe(10);
  });

  it('a failing job retries with back-off, then parks and emails CONTACT_EMAIL', async () => {
    const outbox = new Outbox();
    const r = runner(outbox);
    let calls = 0;
    r.register({
      name: 'flaky',
      async run() {
        calls++;
        throw new TypeError('boom');
      },
    });
    await r.enqueue('flaky', t.clock.now, 3);
    const repo = new JobsRepository(t.db);
    expect(await r.tick()).toBe(true);
    expect(await r.tick()).toBe(false);
    t.clock.advance(31_000);
    expect(await r.tick()).toBe(true);
    t.clock.advance(30_000);
    expect(await r.tick()).toBe(false);
    t.clock.advance(31_000);
    expect(await r.tick()).toBe(true);
    expect(calls).toBe(3);
    t.clock.advance(10 * 60_000);
    expect(await r.tick()).toBe(false);
    const parked = await t.db.collection('jobs').findOne({ name: 'flaky' });
    expect(parked).toMatchObject({ status: 'parked', attempts: 3, lastError: 'TypeError' });
    expect(await repo.byId(parked!._id as unknown as string)).toMatchObject({ status: 'parked' });
    expect(outbox.messages.map((m) => [m.to, m.template])).toEqual([['ops@myledja.test', 'job_parked']]);
  });

  it('a job whose runner died is taken again after its lease lapses', async () => {
    const r = runner();
    let calls = 0;
    r.register({
      name: 'lease',
      async run() {
        calls++;
      },
    });
    await r.enqueue('lease', t.clock.now);
    const repo = new JobsRepository(t.db);
    expect(await repo.claim('dead-runner', t.clock.now, 60_000, ['lease'])).not.toBeNull();
    expect(await r.tick()).toBe(false);
    t.clock.advance(61_000);
    expect(await r.tick()).toBe(true);
    expect(calls).toBe(1);
  });

  it('the clean-expired job is scheduled once and repeats hourly', async () => {
    const { jobs } = t.services;
    await jobs.schedule();
    await jobs.schedule();
    expect(await t.db.collection('jobs').countDocuments({ name: 'clean-expired' })).toBe(1);
    await t.db
      .collection('rate_limits')
      .insertOne({ _id: 'old' as never, count: 1, level: 0, lockedUntil: null, expiresAt: new Date(0) });
    t.clock.advance(1000);
    expect(await jobs.tick()).toBe(true);
    expect(await t.db.collection('rate_limits').findOne({ _id: 'old' as never })).toBeNull();
    const job = await t.db.collection('jobs').findOne({ name: 'clean-expired' });
    expect(job).toMatchObject({ status: 'queued' });
    expect(job!.runAt.getTime()).toBeGreaterThan(t.clock.now.getTime() + 3500_000);
  });
});
