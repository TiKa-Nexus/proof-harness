// Import External Packages
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Transient-failure retry
//
// Local Supabase sits behind Kong. During a proof run — every spec seeding its
// own fixtures through the service role, plus the dev server's own queries — the
// gateway intermittently answers a request with a 502 whose body reads "An
// invalid response was received from the upstream server", then serves the next
// request normally. Roughly one local `proof:check` in two hit this, always on a
// different spec.
//
// That noise is not evidence about the code under test, and it can hurt in two
// ways:
//
//   1. A spurious red build. Worse than it sounds: a suite that fails half the
//      time for reasons nobody controls teaches people to re-run until green,
//      which is exactly the reflex that lets a real failure through.
//   2. A false pass. Several probes read "the actor's write returned an error and
//      no row landed" as proof of denial. A write that never reached PostgREST
//      looks identical, so an unretried gateway error can certify an invariant
//      that was never exercised. Callers use `isTransient` to refuse that
//      reading.
//
// The retry lives at the transport (`createRetryingFetch`, installed on every
// Supabase client the SDK hands out) rather than at each call site, because the
// call sites that matter most are the ad-hoc queries inside `.proof.ts` specs —
// there is no version of "remember to wrap it" that survives the next spec
// somebody writes.
//
// It is bounded, announced on stdout, and deliberately narrow: only gateway
// statuses (502/503/504) and transport-level failures qualify. A 4xx is the
// database answering, and even a 500 is usually PostgREST or a route handler
// answering; retrying either would turn a real failure into a slow real failure,
// or worse, hide it.
// ---------------------------------------------------------------------------

/** The shape both `PostgrestError` and `AuthError` satisfy. */
export interface TransientErrorLike {
  message?: string | null;
  status?: number | null;
  code?: string | null;
}

/**
 * Messages that mean "the request did not reach the database", matched because
 * Supabase surfaces gateway and transport failures as error text without a
 * usable status on every client path.
 */
const TRANSIENT_MESSAGES = [
  /invalid response was received from the upstream server/i,
  /upstream connect error/i,
  /(service|server) (is )?temporarily unavailable/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /fetch failed/i,
  /network( request)? failed/i,
  /socket hang up/i,
  /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR/,
];

/** Node wraps the real cause; the useful text is often one or two levels down. */
function messageChain(error: unknown, depth = 0): string {
  if (!error || depth > 3) return "";
  if (typeof error === "string") return error;
  const record = error as { message?: unknown; cause?: unknown };
  const own = typeof record.message === "string" ? record.message : "";
  return `${own} ${messageChain(record.cause, depth + 1)}`;
}

/**
 * Statuses the gateway returns when it could not get an answer out of the
 * upstream service. A 500 is excluded on purpose: PostgREST and our own route
 * handlers use it to report real failures.
 */
export const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * True when a failure is infrastructure, not an answer.
 *
 * `status` is the HTTP status when the caller has it separately from the error
 * (PostgREST responses carry it alongside `error`; auth errors carry it inside).
 */
export function isTransient(
  error: TransientErrorLike | null | undefined,
  status?: number | null,
): boolean {
  if (!error) return false;
  const httpStatus = status ?? error.status ?? null;
  if (typeof httpStatus === "number") {
    if (GATEWAY_STATUSES.has(httpStatus)) return true;
    // Any other status is the stack answering — a denial, a validation error, an
    // internal error — and each is a fact the proof is entitled to act on.
    if (httpStatus >= 400) return false;
  }
  const text = messageChain(error);
  return TRANSIENT_MESSAGES.some((pattern) => pattern.test(text));
}

export const TRANSIENT_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 150;

function backoffMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

function announce(
  label: string,
  attempt: number,
  maxAttempts: number,
  reason: string,
  delayMs: number,
): void {
  // Announced rather than silent: a suite that only goes green on its third
  // attempt every time is a real problem, and hidden retries hide it.
  console.log(
    `[proof:retry] ${label} failed transiently (attempt ${attempt}/${maxAttempts}): ` +
      `${reason} — retrying in ${delayMs}ms`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `fetch` that retries gateway failures, for installing on a Supabase client
 * via `createClient(url, key, { global: { fetch } })`.
 *
 * Covers every request that client makes — PostgREST queries, auth admin calls,
 * RPC — including the ad-hoc ones written inside proof specs, which is the whole
 * reason the retry lives here instead of at the call sites.
 *
 * Retrying a write is safe here only because gateway failures mean the request
 * did not reach PostgREST; a request carrying a stream body is never retried,
 * since it cannot be replayed and we cannot know how far it got.
 */
export function createRetryingFetch(
  label: string,
  baseFetch: typeof fetch = fetch,
  { maxAttempts = TRANSIENT_MAX_ATTEMPTS } = {},
): typeof fetch {
  return async (input, init) => {
    const replayable =
      init?.body == null ||
      typeof init.body === "string" ||
      init.body instanceof URLSearchParams;

    for (let attempt = 1; ; attempt++) {
      const lastAttempt = attempt >= maxAttempts || !replayable;
      try {
        const response = await baseFetch(input, init);
        if (lastAttempt || !GATEWAY_STATUSES.has(response.status)) {
          return response;
        }
        const delayMs = backoffMs(attempt);
        announce(
          label,
          attempt,
          maxAttempts,
          `HTTP ${response.status}`,
          delayMs,
        );
        await sleep(delayMs);
      } catch (error) {
        if (lastAttempt || !isTransient(error as TransientErrorLike))
          throw error;
        const delayMs = backoffMs(attempt);
        announce(
          label,
          attempt,
          maxAttempts,
          messageChain(error).trim() || "transport failure",
          delayMs,
        );
        await sleep(delayMs);
      }
    }
  };
}

/**
 * Retry a call that reports failure in its result rather than by throwing.
 *
 * For anything going through a Supabase client, prefer `createRetryingFetch` —
 * it is already installed. This is for the surfaces that do not use it, such as
 * Playwright's `APIRequestContext`.
 *
 * `run` must build the request from scratch on each call: a PostgREST builder is
 * a one-shot thenable, so re-awaiting the same object does not re-issue it.
 *
 * The final result is returned as-is — including a still-failing error — because
 * the caller owns the diagnostics. Nothing here throws, and nothing here decides
 * what a failure means.
 */
export async function retryTransient<
  T extends { error?: TransientErrorLike | null; status?: number },
>(
  label: string,
  // `PromiseLike`, not `Promise`: a PostgREST builder is a thenable, and typing
  // this as `Promise<T>` makes inference fall back to the constraint, which
  // erases `data` and `count` from the caller's result.
  run: () => PromiseLike<T>,
  { maxAttempts = TRANSIENT_MAX_ATTEMPTS } = {},
): Promise<T> {
  let result = await run();

  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    if (!isTransient(result.error, result.status)) return result;
    const delayMs = backoffMs(attempt);
    announce(
      label,
      attempt,
      maxAttempts,
      result.error?.message ?? "unknown error",
      delayMs,
    );
    await sleep(delayMs);
    result = await run();
  }

  return result;
}
