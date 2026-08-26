// ---------------------------------------------------------------------------
// Bounded authentication rate-limit retry.
//
// HTTP 429 is neither a product verdict nor a transient gateway failure. Proof
// login may retry it briefly, honoring Retry-After within a strict budget; once
// exhausted it remains an explicit auth_rate_limited infrastructure diagnosis.
// ---------------------------------------------------------------------------

export interface AuthRateLimitErrorLike {
  message?: string | null;
  status?: number | null;
}

export const AUTH_RATE_LIMIT_MAX_ATTEMPTS = 3;
export const AUTH_RATE_LIMIT_MAX_DELAY_MS = 5_000;
export const AUTH_RATE_LIMIT_MAX_TOTAL_WAIT_MS = 10_000;
const AUTH_RATE_LIMIT_FALLBACK_DELAY_MS = 1_000;

export function isAuthRateLimited(
  error: AuthRateLimitErrorLike | null | undefined,
  status?: number | null,
  body?: string | null,
): boolean {
  const httpStatus = status ?? error?.status ?? null;
  if (httpStatus === 429) return true;
  if (typeof httpStatus === "number" && httpStatus >= 400) return false;

  const text = `${error?.message ?? ""} ${body ?? ""}`;
  return (
    /\[PROOF_FAIL\]\s*(auth_)?rate_limited:/i.test(text) ||
    /\b(rate limit|too many (requests|attempts|sign-?ins?))\b/i.test(text)
  );
}

export function parseRetryAfterMs(
  value: string | number | null | undefined,
  now = Date.now(),
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value * 1_000);
  }
  if (typeof value !== "string" || !value.trim()) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function clampAuthRateLimitDelay(
  retryAfterMs: number | null,
  remainingBudgetMs = AUTH_RATE_LIMIT_MAX_TOTAL_WAIT_MS,
): number {
  const requested = retryAfterMs ?? AUTH_RATE_LIMIT_FALLBACK_DELAY_MS;
  return Math.max(
    0,
    Math.min(requested, AUTH_RATE_LIMIT_MAX_DELAY_MS, remainingBudgetMs),
  );
}

export async function retryAuthRateLimit<T>(
  label: string,
  run: () => PromiseLike<T>,
  classify: (result: T) => {
    limited: boolean;
    retryAfter?: string | number | null;
  },
  {
    maxAttempts = AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    maxTotalWaitMs = AUTH_RATE_LIMIT_MAX_TOTAL_WAIT_MS,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = {},
): Promise<T> {
  let result = await run();
  let waitedMs = 0;

  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const signal = classify(result);
    if (!signal.limited) return result;

    const remaining = maxTotalWaitMs - waitedMs;
    if (remaining <= 0) return result;
    const delayMs = clampAuthRateLimitDelay(
      parseRetryAfterMs(signal.retryAfter),
      remaining,
    );
    if (delayMs <= 0) return result;

    console.log(
      `[proof:retry] ${label} auth rate limited (attempt ${attempt}/${maxAttempts}) — retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
    waitedMs += delayMs;
    result = await run();
  }

  return result;
}
