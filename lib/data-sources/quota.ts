/**
 * Per-source quota tracking and exponential backoff.
 *
 * Every source in this project is on a free tier with a published limit, and
 * blowing through it gets the key throttled or banned — so each one declares
 * its limit here and spends against it before the request goes out.
 *
 * Scope, stated plainly: this state lives in the process. Serverless instances
 * are ephemeral and there can be several warm at once, so the real ceiling is
 * (instances × limit), not (limit). That makes this a strong guard against the
 * common case — one instance looping 9 symbols — and a weak one against a
 * fleet. Making it exact needs a shared counter (Postgres/Redis); see the
 * README's note. It deliberately errs toward under-spending: a counter that
 * resets on cold start would over-spend, so windows are wall-clock based.
 */

export interface QuotaLimit {
  /** Requests per rolling 60s window, e.g. Groq's 30 req/min. */
  perMinute?: number;
  /** Requests per UTC day, e.g. Gemini's 1500 req/day. */
  perDay?: number;
}

interface SourceState {
  /** Timestamps of recent calls, trimmed to the last 60s. */
  recent: number[];
  /** UTC day string the daily counter belongs to. */
  day: string;
  dayCount: number;
  /** Consecutive failures; drives the backoff delay. */
  failures: number;
  /** Epoch ms before which no call may be made. */
  blockedUntil: number;
}

const states = new Map<string, SourceState>();

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
/** Beyond this the delay is already capped, so stop growing the exponent. */
const MAX_TRACKED_FAILURES = 8;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function stateFor(source: string): SourceState {
  const existing = states.get(source);
  if (existing) return existing;
  const fresh: SourceState = {
    recent: [],
    day: utcDay(),
    dayCount: 0,
    failures: 0,
    blockedUntil: 0,
  };
  states.set(source, fresh);
  return fresh;
}

export type QuotaDecision =
  | { ok: true }
  | { ok: false; reason: string; retryAfterMs: number };

/**
 * Consumes one call from `source`'s budget if it has room and is not backing
 * off. Callers that get `ok: false` must serve cached data or report a gap —
 * never fabricate a value.
 */
export function tryConsume(source: string, limit: QuotaLimit): QuotaDecision {
  const now = Date.now();
  const s = stateFor(source);

  if (now < s.blockedUntil) {
    const retryAfterMs = s.blockedUntil - now;
    // Deliberately vague about the mechanism. "指數退避中，還要等 28 秒" told
    // the reader about our retry policy, which they can do nothing with, and
    // buried the only fact that matters: this source is currently down.
    return {
      ok: false,
      reason: `${source} 目前連線不穩（已連續失敗 ${s.failures} 次），暫時停止重試`,
      retryAfterMs,
    };
  }

  const today = utcDay();
  if (s.day !== today) {
    s.day = today;
    s.dayCount = 0;
  }
  if (limit.perDay !== undefined && s.dayCount >= limit.perDay) {
    const nextUtcMidnight = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() + 1,
    );
    return {
      ok: false,
      reason: `${source} 今日額度 ${limit.perDay} 次已用盡`,
      retryAfterMs: nextUtcMidnight - now,
    };
  }

  if (limit.perMinute !== undefined) {
    s.recent = s.recent.filter((t) => now - t < 60_000);
    if (s.recent.length >= limit.perMinute) {
      const oldest = s.recent[0];
      return {
        ok: false,
        reason: `${source} 每分鐘額度 ${limit.perMinute} 次已用盡`,
        retryAfterMs: Math.max(0, 60_000 - (now - oldest)),
      };
    }
  }

  s.recent.push(now);
  s.dayCount += 1;
  return { ok: true };
}

/** Clears the backoff — the source is healthy again. */
export function recordSuccess(source: string): void {
  const s = stateFor(source);
  s.failures = 0;
  s.blockedUntil = 0;
}

/** Doubles the wait before this source is tried again, capped at 5 minutes. */
export function recordFailure(source: string): void {
  const s = stateFor(source);
  s.failures = Math.min(s.failures + 1, MAX_TRACKED_FAILURES);
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (s.failures - 1), BACKOFF_MAX_MS);
  s.blockedUntil = Date.now() + delay;
}

/** Snapshot for /api/diagnostics. Read-only — does not consume budget. */
export function quotaSnapshot(): Record<
  string,
  { usedToday: number; usedLastMinute: number; failures: number; blockedForMs: number }
> {
  const now = Date.now();
  const today = utcDay();
  const out: Record<
    string,
    { usedToday: number; usedLastMinute: number; failures: number; blockedForMs: number }
  > = {};
  for (const [source, s] of states) {
    out[source] = {
      usedToday: s.day === today ? s.dayCount : 0,
      usedLastMinute: s.recent.filter((t) => now - t < 60_000).length,
      failures: s.failures,
      blockedForMs: Math.max(0, s.blockedUntil - now),
    };
  }
  return out;
}

/** Test seam — resets all counters. */
export function __resetQuotaForTests(): void {
  states.clear();
}
