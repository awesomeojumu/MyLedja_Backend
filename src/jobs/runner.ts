import { Logger } from '@nestjs/common';
import { newId } from '../common/ids/ids.js';
import type { Mailer } from '../modules/notifications/email/email.js';
import type { JobDoc, JobsRepository } from './jobs.repository.js';

export type JobHandler = {
  name: string;
  /** Repeats on this interval; one shared job per name. */
  everySeconds?: number;
  maxAttempts?: number;
  run(job: JobDoc): Promise<void>;
};

const LEASE_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 30_000;

/**
 * The job worker inside the API process (TECH-SPEC 5.6): claims jobs with leases, retries with back-off,
 * parks a job after too many failures and tells CONTACT_EMAIL.
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly logger = new Logger('Jobs');
  readonly owner = newId();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly jobs: JobsRepository,
    private readonly mailer: Mailer,
    private readonly contactEmail: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(handler: JobHandler) {
    this.handlers.set(handler.name, handler);
  }

  async schedule() {
    for (const h of this.handlers.values()) {
      if (h.everySeconds)
        await this.jobs.ensureRepeating(`repeat:${h.name}`, h.name, h.everySeconds, h.maxAttempts ?? 5, this.now());
    }
  }

  async enqueue(name: string, runAt = this.now(), maxAttempts = 5) {
    const now = this.now();
    await this.jobs.enqueue({
      _id: newId(),
      name,
      status: 'queued',
      runAt,
      attempts: 0,
      maxAttempts,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      repeatEverySeconds: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Claims and runs one due job. Returns false when nothing was due. */
  async tick(): Promise<boolean> {
    const now = this.now();
    const job = await this.jobs.claim(this.owner, now, LEASE_MS, [...this.handlers.keys()]);
    if (!job) return false;
    const handler = this.handlers.get(job.name)!;
    try {
      await handler.run(job);
      await this.jobs.finish(job, this.owner, this.now());
    } catch (e) {
      const code = e instanceof Error ? e.name : 'error';
      const attempts = job.attempts + 1;
      const parked = attempts >= job.maxAttempts;
      const retryAt = parked ? null : new Date(this.now().getTime() + BASE_BACKOFF_MS * 2 ** job.attempts);
      await this.jobs.fail(job, this.owner, this.now(), code, retryAt);
      this.logger.error(
        JSON.stringify({ event: parked ? 'job_parked' : 'job_failed', job: job.name, id: job._id, attempts, code }),
      );
      if (parked && this.contactEmail) await this.mailer.jobParked(this.contactEmail, job.name, job._id);
    }
    return true;
  }

  start(intervalMs = 15_000) {
    if (this.timer) return;
    const loop = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        while (await this.tick()) {
          // drain everything that's due
        }
      } catch (e) {
        this.logger.error(JSON.stringify({ event: 'job_loop_failed', code: e instanceof Error ? e.name : 'error' }));
      } finally {
        this.busy = false;
      }
    };
    void this.schedule().then(loop);
    this.timer = setInterval(() => void loop(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
