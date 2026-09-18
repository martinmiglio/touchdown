import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../../src/adapters/retry.js";

interface FakeHttpError extends Error {
  status: number;
  response: { headers: Record<string, string> };
}

function httpError(status: number, headers: Record<string, string> = {}): FakeHttpError {
  const err = new Error(`HTTP ${status}`) as FakeHttpError;
  err.status = status;
  err.response = { headers };
  return err;
}

function recorder() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number): Promise<void> => {
    delays.push(ms);
  });
  return { delays, sleep };
}

describe("withRetry", () => {
  it("403 + retry-after: 7 waits 7000 ms once, then succeeds", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(403, { "retry-after": "7" }))
      .mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { sleep, maxDelayMs: 120_000 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([7000]);
  });

  it("429 + retry-after follows the same path", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429, { "retry-after": "3" }))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep, maxDelayMs: 120_000 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([3000]);
  });

  it("403 + x-ratelimit-remaining: 0 + reset 30 s ahead waits ~30 000 ms", async () => {
    const { delays, sleep } = recorder();
    const resetEpochSec = 1030; // now() is 1_000_000 ms = epoch 1000 s
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        httpError(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSec),
        }),
      )
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep, now: () => 1_000_000, maxDelayMs: 120_000 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([30_000]);
  });

  it("403 with neither header waits 60 000 ms", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(403))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep, maxDelayMs: 120_000 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([60_000]);
  });

  it("500 backs off 500, 1000, 2000 ms", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("network error without status uses exponential backoff", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });

  it("422 is rethrown immediately with zero sleeps and exactly one call", async () => {
    const { delays, sleep } = recorder();
    const cause = httpError(422);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(cause);
    await expect(withRetry(fn, { sleep })).rejects.toBe(cause);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });

  it("404 is rethrown immediately", async () => {
    const { sleep } = recorder();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(httpError(404));
    await expect(withRetry(fn, { sleep })).rejects.toMatchObject({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("exhaustion after attempts rethrows the last error", async () => {
    const { delays, sleep } = recorder();
    const last = httpError(500);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(last);
    await expect(withRetry(fn, { sleep, attempts: 3 })).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("delays are capped at maxDelayMs", async () => {
    const { delays, sleep } = recorder();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(httpError(500));
    await expect(withRetry(fn, { sleep, attempts: 4, maxDelayMs: 750 })).rejects.toMatchObject({
      status: 500,
    });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 750, 750]);
  });

  it("rate-limit fallback delay is capped at maxRateLimitDelayMs", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(403))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep, maxRateLimitDelayMs: 1000 });
    expect(delays).toEqual([1000]);
  });

  it("with DEFAULT options a bare 403 sleeps exactly 60_000", async () => {
    const { delays, sleep } = recorder();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(403))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([60_000]);
  });

  it("x-ratelimit-reset 10 minutes out sleeps 60_000 (capped) with defaults", async () => {
    const { delays, sleep } = recorder();
    const resetEpochSec = 1600; // now() is 1_000_000 ms = epoch 1000 s → raw delay 600_000 ms
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        httpError(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSec),
        }),
      )
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep, now: () => 1_000_000 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([60_000]);
  });

  it("wraps non-Error rejections in Error and still retries then throws Error", async () => {
    const { delays, sleep } = recorder();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue("boom");
    const caught = await withRetry(fn, { sleep, attempts: 2 }).then(
      () => {
        throw new Error("should have thrown");
      },
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });
});
