// Import External Packages
import { describe, expect, it, vi, afterEach } from "vitest";
// Import Local Imports
import {
  createRetryingFetch,
  isTransient,
  retryTransient,
  TRANSIENT_MAX_ATTEMPTS,
} from "../server/transient";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// The retry exists so gateway noise cannot fail a run, and `isTransient` exists
// so gateway noise cannot PASS one — several probes read "the write errored and
// no row landed" as proof of denial, which is what an unanswered request also
// looks like.
//
// Both directions are load-bearing, so the tests that matter most here are the
// negative ones: a 403 must never be retried into silence, and a real error must
// never be classified as infrastructure.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

/** Suppress the retry announcements so test output stays readable. */
function silenceLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("isTransient", () => {
  it("treats a 5xx as infrastructure", () => {
    expect(isTransient({ message: "Bad Gateway" }, 502)).toBe(true);
    expect(isTransient({ message: "boom", status: 503 })).toBe(true);
  });

  it("treats a 4xx as an answer, whatever the message says", () => {
    // The dangerous case: an RLS denial that mentions a retryable-sounding word
    // must still be read as a verdict.
    expect(
      isTransient({ message: "new row violates row-level security" }, 403),
    ).toBe(false);
    expect(isTransient({ message: "fetch failed" }, 401)).toBe(false);
    expect(isTransient({ message: "Too Many Requests" }, 429)).toBe(false);
  });

  it("treats a 500 as an answer, because PostgREST and route handlers use it", () => {
    expect(isTransient({ message: "internal error" }, 500)).toBe(false);
  });

  it("recognises the local gateway's 502 body without a status", () => {
    expect(
      isTransient({
        message: "An invalid response was received from the upstream server",
      }),
    ).toBe(true);
  });

  it("recognises transport failures, including nested causes", () => {
    expect(isTransient({ message: "TypeError: fetch failed" })).toBe(true);
    const wrapped = Object.assign(new Error("request failed"), {
      cause: new Error("connect ECONNRESET 127.0.0.1:54321"),
    });
    expect(isTransient(wrapped)).toBe(true);
  });

  it("does not classify an ordinary Postgres error as transient", () => {
    expect(
      isTransient({
        message: 'relation "public.widgets" does not exist',
        code: "42P01",
      }),
    ).toBe(false);
  });

  it("is false when there is no error at all", () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe("retryTransient", () => {
  it("returns the first success without retrying", async () => {
    // Typed via the implementation so the assertion below sees `data` — proof
    // that the helper preserves the caller's response shape rather than
    // narrowing it to the constraint.
    const run = vi.fn(async () => ({ data: [{ id: 1 }], error: null }));
    const result = await retryTransient("probe", run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([{ id: 1 }]);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    silenceLog();
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: "An invalid response was received from the upstream server",
        },
        status: 502,
      })
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null, status: 200 });
    const result = await retryTransient("probe", run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.error).toBeNull();
  });

  it("does not retry an answer, so a denial stays a denial", async () => {
    const run = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "permission denied for table widgets" },
      status: 403,
    });
    const result = await retryTransient("probe", run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(403);
  });

  it("gives up after the attempt budget and hands back the failure", async () => {
    silenceLog();
    const run = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "bad gateway" },
      status: 502,
    });
    const result = await retryTransient("probe", run, { maxAttempts: 3 });
    expect(run).toHaveBeenCalledTimes(3);
    // Returned rather than thrown: the caller decides what a failure means.
    expect(result.error?.message).toBe("bad gateway");
  });

  it("announces each retry, so a suite that only passes on attempt three is visible", async () => {
    const log = silenceLog();
    const run = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "bad gateway" }, status: 502 })
      .mockResolvedValueOnce({ error: null, status: 200 });
    await retryTransient("seed.workspace(Acme)", run);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain(
      "[proof:retry] seed.workspace(Acme)",
    );
  });

  it("defaults to a bounded budget", () => {
    expect(TRANSIENT_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(TRANSIENT_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});

describe("createRetryingFetch", () => {
  const ok = () => new Response("{}", { status: 200 });
  const gateway = () => new Response("upstream", { status: 502 });

  it("retries a gateway response and returns the one that succeeds", async () => {
    silenceLog();
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(gateway())
      .mockResolvedValueOnce(ok());
    const response = await createRetryingFetch(
      "probe",
      base,
    )("/rest/v1/widgets");
    expect(base).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it("passes a 403 straight through, so a denial is never retried away", async () => {
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("denied", { status: 403 }));
    const response = await createRetryingFetch(
      "probe",
      base,
    )("/rest/v1/widgets");
    expect(base).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
  });

  it("returns the last gateway response once the budget is spent", async () => {
    silenceLog();
    const base = vi.fn<typeof fetch>().mockResolvedValue(gateway());
    const response = await createRetryingFetch("probe", base, {
      maxAttempts: 3,
    })("/rest/v1/widgets");
    expect(base).toHaveBeenCalledTimes(3);
    // Returned, not thrown: the caller's own guard decides what it means, and
    // for a probe that means failing rather than reading it as a denial.
    expect(response.status).toBe(502);
  });

  it("retries a thrown transport error", async () => {
    silenceLog();
    const base = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        Object.assign(new Error("fetch failed"), {
          cause: new Error("connect ECONNREFUSED"),
        }),
      )
      .mockResolvedValueOnce(ok());
    const response = await createRetryingFetch(
      "probe",
      base,
    )("/rest/v1/widgets");
    expect(response.status).toBe(200);
  });

  it("rethrows a non-transport error without retrying", async () => {
    const base = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Invalid URL"));
    await expect(
      createRetryingFetch("probe", base)("/rest/v1/widgets"),
    ).rejects.toThrow("Invalid URL");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("does not replay a request whose body cannot be replayed", async () => {
    // A stream body has already been partially consumed, and we cannot know how
    // much of the write landed — so the failure is surfaced instead of retried.
    const base = vi.fn<typeof fetch>().mockResolvedValue(gateway());
    const body = new ReadableStream();
    const response = await createRetryingFetch("probe", base)(
      "/rest/v1/widgets",
      {
        method: "POST",
        body,
        // @ts-expect-error -- duplex is required for stream bodies at runtime
        duplex: "half",
      },
    );
    expect(base).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
  });
});
