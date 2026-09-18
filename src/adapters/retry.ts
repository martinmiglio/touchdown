export interface RetryOptions {
  /** Total tries: 1 initial try + retries. Default 4. */
  attempts?: number;
  /** Injectable clock for tests. Default real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  /** Cap for exponential backoff (network / 5xx). Default 30_000. */
  maxDelayMs?: number;
  /** Cap for rate-limit delays (403 / 429). Default 60_000. */
  maxRateLimitDelayMs?: number;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RATE_LIMIT_DELAY_MS = 60_000;
const FALLBACK_RATE_LIMIT_DELAY_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Classified {
  status?: number;
  headers: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Extract `status` and lower-cased `headers` per the classification contract. */
function extract(raw: unknown): Classified {
  const rec = asRecord(raw);
  const status =
    typeof rec?.["status"] === "number"
      ? (rec["status"] as number)
      : typeof asRecord(rec?.["response"])?.["status"] === "number"
        ? (asRecord(rec?.["response"])?.["status"] as number)
        : undefined;
  // Real Octokit RequestError also carries top-level `headers`; accept both.
  const rawHeaders =
    asRecord(asRecord(rec?.["response"])?.["headers"]) ?? asRecord(rec?.["headers"]) ?? {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string" || typeof value === "number") {
      headers[key.toLowerCase()] = String(value);
    }
  }
  return { status, headers };
}

function wrapNonError(raw: unknown): Error {
  if (typeof raw === "string") return new Error(raw);
  let detail: string;
  try {
    detail = JSON.stringify(raw) ?? String(raw);
  } catch {
    detail = String(raw);
  }
  return new Error(`non-error thrown: ${detail}`);
}

/**
 * Retry delay in ms, or null when the error is not retryable.
 * `attempt` is the 1-based number of the attempt that just failed.
 * Exponential backoff is capped at `maxDelayMs`; rate-limit delays
 * (403 / 429) are capped at `maxRateLimitDelayMs`.
 */
function retryDelayMs(
  status: number | undefined,
  headers: Record<string, string>,
  attempt: number,
  now: () => number,
  maxDelayMs: number,
  maxRateLimitDelayMs: number,
): number | null {
  if (status === undefined || status >= 500) {
    return Math.min(500 * 2 ** (attempt - 1), maxDelayMs);
  }
  if (status === 403 || status === 429) {
    const retryAfter = headers["retry-after"];
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, maxRateLimitDelayMs);
      }
    }
    if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"] !== undefined) {
      const resetSeconds = Number(headers["x-ratelimit-reset"]);
      if (Number.isFinite(resetSeconds)) {
        const raw = Math.max(0, Math.ceil((resetSeconds * 1000 - now()) / 1000)) * 1000;
        return Math.min(raw, maxRateLimitDelayMs);
      }
    }
    return Math.min(FALLBACK_RATE_LIMIT_DELAY_MS, maxRateLimitDelayMs);
  }
  return null;
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts?.attempts ?? DEFAULT_ATTEMPTS));
  const sleep = opts?.sleep ?? defaultSleep;
  const now = opts?.now ?? Date.now;
  const maxDelayMs = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRateLimitDelayMs = opts?.maxRateLimitDelayMs ?? DEFAULT_MAX_RATE_LIMIT_DELAY_MS;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (raw: unknown) {
      const err = raw instanceof Error ? raw : wrapNonError(raw);
      lastError = err;
      const { status, headers } = extract(raw);
      const delay = retryDelayMs(status, headers, attempt, now, maxDelayMs, maxRateLimitDelayMs);
      if (delay === null || attempt >= maxAttempts) throw err;
      await sleep(delay);
    }
  }
  // Unreachable: the loop always throws or returns. Guards against attempts <= 0.
  throw lastError ?? new Error("withRetry: no attempts made");
}
