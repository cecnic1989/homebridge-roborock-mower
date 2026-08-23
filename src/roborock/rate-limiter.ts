export interface RateLimit {
  count: number;
  perMs: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Budgets copied from python-roborock. Roborock publishes no limits; ~15 home-data calls/hour
// has been observed to put an account into a degraded state, so these are deliberately conservative.
export const LOGIN_LIMITS: RateLimit[] = [
  { count: 1, perMs: SECOND }, { count: 3, perMs: MINUTE }, { count: 10, perMs: HOUR }, { count: 20, perMs: DAY },
];
export const HOME_DATA_LIMITS: RateLimit[] = [
  { count: 1, perMs: SECOND }, { count: 3, perMs: MINUTE }, { count: 5, perMs: HOUR }, { count: 40, perMs: DAY },
];

export class RateLimiter {
  private stamps: number[] = [];
  private readonly longestWindow: number;

  constructor(private readonly limits: RateLimit[], private readonly now: () => number = () => Date.now()) {
    this.longestWindow = Math.max(...limits.map((l) => l.perMs));
  }

  tryAcquire(): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((stamp) => stamp > t - this.longestWindow);
    for (const { count, perMs } of this.limits) {
      if (this.stamps.filter((stamp) => stamp > t - perMs).length >= count) {
        return false;
      }
    }
    this.stamps.push(t);
    return true;
  }
}
