// Import External Packages
import { describe, expect, it, vi } from "vitest";
// Import Local Imports
import {
  AUTH_RATE_LIMIT_MAX_DELAY_MS,
  clampAuthRateLimitDelay,
  isAuthRateLimited,
  parseRetryAfterMs,
  retryAuthRateLimit,
} from "../server/auth-rate-limit";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

describe("authentication rate-limit classification", () => {
  it("classifies HTTP 429 without confusing a 403 verdict", () => {
    expect(isAuthRateLimited({ message: "Too Many Requests" }, 429)).toBe(true);
    expect(
      isAuthRateLimited({ message: "rate limit policy denied" }, 403),
    ).toBe(false);
  });

  it("recognises status-less Supabase auth rate-limit messages", () => {
    expect(
      isAuthRateLimited({
        message: "Too many sign-in attempts; please try again later",
      }),
    ).toBe(true);
  });

  it("parses seconds and HTTP-date Retry-After values", () => {
    expect(parseRetryAfterMs("3", 0)).toBe(3_000);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:04 GMT", 1_000)).toBe(
      3_000,
    );
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });

  it("clamps server requests to the bounded wait budget", () => {
    expect(clampAuthRateLimitDelay(120_000)).toBe(AUTH_RATE_LIMIT_MAX_DELAY_MS);
    expect(clampAuthRateLimitDelay(5_000, 750)).toBe(750);
  });
});

describe("bounded authentication retry", () => {
  it("retries 429 and returns the eventual success", async () => {
    const sleep = vi.fn(async () => {});
    const run = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, retryAfter: "1" })
      .mockResolvedValueOnce({ status: 200 });

    const result = await retryAuthRateLimit<{
      status: number;
      retryAfter?: string;
    }>(
      "proof login",
      run,
      (value) => ({
        limited: value.status === 429,
        retryAfter: value.retryAfter,
      }),
      { sleep },
    );

    expect(result.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("does not retry ordinary authorization failures", async () => {
    const sleep = vi.fn(async () => {});
    const run = vi.fn().mockResolvedValue({ status: 403 });

    const result = await retryAuthRateLimit<{ status: number }>(
      "proof login",
      run,
      (value) => ({ limited: value.status === 429 }),
      { sleep },
    );

    expect(result.status).toBe(403);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the attempt budget and returns the final 429", async () => {
    const sleep = vi.fn(async () => {});
    const run = vi.fn().mockResolvedValue({ status: 429 });

    const result = await retryAuthRateLimit<{ status: number }>(
      "proof login",
      run,
      (value) => ({ limited: value.status === 429 }),
      { maxAttempts: 3, sleep },
    );

    expect(result.status).toBe(429);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
