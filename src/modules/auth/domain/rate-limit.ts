const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimit {
  private readonly hits = new Map<string, Bucket>();

  constructor(
    private readonly max: number = DEFAULT_MAX,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
  ) {}

  isLimited(key: string, now: number = Date.now()): boolean {
    const bucket = this.hits.get(key);
    if (!bucket) {
      return false;
    }
    if (bucket.resetAt <= now) {
      this.hits.delete(key);
      return false;
    }
    return bucket.count >= this.max;
  }

  record(key: string, now: number = Date.now()): void {
    const bucket = this.hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    bucket.count += 1;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
