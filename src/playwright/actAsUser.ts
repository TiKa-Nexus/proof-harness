// Import External Packages
import type { Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// Import Local Imports
import { createRetryingFetch, retryTransient } from "../server/transient";
import {
  isAuthRateLimited,
  retryAuthRateLimit,
} from "../server/auth-rate-limit";
import type { ActionResult } from "../shared/action-types";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// actAsUser
//
// Two surfaces for "become a user" inside a proof spec:
//
//   1. `actAsUser.login(page, role)` / `actAsUser.loginAs(page, email, pw)`
//      — log a Playwright browser context into Supabase via
//        `POST /api/proof/login-as-seed-user`. Use when the proof drives the
//        UI: cookies are written into `page.request`'s shared jar and Next.js
//        sees the session after a `page.reload()`.
//
//   2. `actAsUser.supabaseClient({ email, password })`
//      — return a *fresh* Supabase client authenticated as the given user, no
//        cookies involved. Use when the proof needs to query / mutate the DB
//        with the user's real RLS privileges, entirely outside the browser
//        (e.g. "prove user B's DELETE against user A's row is filtered by
//        RLS"). This is the primitive behind `assert.tenantIsolation`'s
//        primary check.
//
// A browser logged in as a disposable proof user must call
// `actAsUser.logout(page)` before deleting that user. It stops trailing page
// requests first, then clears the shared browser/request cookie jar so no
// validly-signed JWT can outlive the auth row named by its `sub` claim.
// ---------------------------------------------------------------------------

interface LoginOkResponse {
  ok: true;
  userId: string | null;
  email: string;
}

interface LoginErrorResponse {
  error: string;
  suggestion: string;
}

interface ActionInvokeErrorResponse {
  success: false;
  error: string;
  suggestion?: string;
}

function isActionResult<TData>(body: unknown): body is ActionResult<TData> {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { success?: unknown; data?: unknown; error?: unknown };
  if (b.success === true) return "data" in b;
  if (b.success === false) return typeof b.error === "string";
  return false;
}

function getProofSecret(): string {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "[PROOF_FAIL] proof_secret_missing: API_SECRET_KEY is not set in the test runner env\n" +
        "  file: src/playwright/actAsUser.ts\n" +
        "  suggestion: Run setup-local-env.sh or ensure .env.local is loaded. Playwright tests need API_SECRET_KEY to sign proof requests.",
    );
  }
  return secret;
}

async function callLoginRoute(
  page: Page,
  payload: { role: "admin" | "member" } | { email: string; password: string },
): Promise<void> {
  // Retried on 5xx only: the route talks to Supabase, so a gateway blip arrives
  // as a server error, while a 401 is the auth system answering and must be
  // reported as-is.
  const { response } = await retryAuthRateLimit(
    "proof login route",
    () =>
      retryTransient("proof login route", async () => {
        const res = await page.request.post("/api/proof/login-as-seed-user", {
          headers: {
            "x-proof-secret": getProofSecret(),
            "Content-Type": "application/json",
          },
          data: payload,
        });
        return {
          response: res,
          status: res.status(),
          error: res.ok()
            ? null
            : { message: res.statusText(), status: res.status() },
        };
      }),
    (result) => ({
      limited: result.status === 429,
      retryAfter:
        typeof result.response.headers === "function"
          ? result.response.headers()["retry-after"]
          : undefined,
    }),
  );

  if (!response.ok()) {
    let body: Partial<LoginErrorResponse> = {};
    try {
      body = (await response.json()) as LoginErrorResponse;
    } catch {
      // Non-JSON error (network / HTML error page). Fall through.
    }
    const label = "email" in payload ? payload.email : `role=${payload.role}`;
    const category = isAuthRateLimited(
      { message: body.error, status: response.status() },
      response.status(),
      body.error,
    )
      ? "auth_rate_limited"
      : "auth_signin";
    throw new Error(
      `[PROOF_FAIL] ${category}: login failed for ${label} (status ${response.status()})\n` +
        `  file: src/playwright/actAsUser.ts\n` +
        `  suggestion: ${body.suggestion ?? body.error ?? "Check that the dev server is running and seed users exist."}`,
    );
  }

  // Validate shape just enough to surface parse errors early.
  const json = (await response.json()) as LoginOkResponse;
  if (!json.ok) {
    throw new Error(
      "[PROOF_FAIL] auth_signin: login route returned ok:false\n" +
        "  file: src/playwright/actAsUser.ts\n" +
        "  suggestion: Inspect the response body of /api/proof/login-as-seed-user.",
    );
  }

  // If the page is already somewhere, reload so Next.js picks up the cookies.
  if (page.url() !== "about:blank") {
    await page.reload();
  }
}

export const actAsUser = {
  /**
   * Log in as one of the seeded development users (`admin` or `member`).
   * The consumer application's proof login route resolves the role to its
   * configured server-only seed credentials.
   */
  async login(page: Page, role: "admin" | "member"): Promise<void> {
    await callLoginRoute(page, { role });
  },

  /**
   * Log in as an arbitrary user — typically one created by `seed.user()`
   * inside a `.proof.ts` spec. Used by `assert.tenantIsolation` and any
   * spec that creates fresh users per run.
   */
  async loginAs(page: Page, email: string, password: string): Promise<void> {
    await callLoginRoute(page, { email, password });
  },

  /**
   * Stop requests from the current document and clear the browser context's
   * shared cookie jar. Call before deleting a disposable user that authenticated
   * this page; otherwise router prefetches or streaming continuations can keep
   * presenting that user's JWT after its auth row is gone.
   */
  async logout(page: Page): Promise<void> {
    const context = page.context();
    if (!page.isClosed()) {
      await page.goto("about:blank");
    }
    await context.clearCookies();
  },

  /**
   * Invoke a server action end-to-end while authenticated as the given user.
   *
   * Unlike `actAsUser.supabaseClient` — which goes directly to the DB and
   * therefore only proves RLS — this helper goes through the full Next.js
   * request lifecycle: route handler → middleware pipeline → `withAuth`,
   * `withTenantIsolation`, the action's own logic, and any Zod validation.
   * It is the primitive you reach for when proving action-layer invariants
   * (RBAC rejection, validation errors, business-logic branching) that RLS
   * alone cannot cover.
   *
   * The action must be listed in
   * the application's generated Proof action registry. Unregistered actions
   * return a 404 with a structured [PROOF_FAIL] message.
   *
   * Authentication:
   *   - `as: "admin" | "member"` — uses the seeded dev users
   *   - `as: { email, password }` — uses arbitrary credentials (typically a
   *     user created by `seed.user()` earlier in the proof)
   *
   * A registered action returns an `ActionResult<TData>`. Harness failures
   * (missing registry entry, malformed request, action escaping the pipeline)
   * throw instead: absence or breakage of the thing under test must never
   * satisfy a refusal proof.
   *
   * @example
   * const result = await actAsUser.invokeAction<{ removed: boolean }>(
   *   page,
   *   {
   *     as: "member",
   *     module: "workspace",
   *     action: "removeMember",
   *     inputParams: { formData: { workspaceId, memberId } },
   *   },
   * );
   * expect(result.success, "[PROOF_FAIL] authorization: ...").toBe(false);
   */
  async invokeAction<TData = unknown>(
    page: Page,
    opts: {
      as: "admin" | "member" | { email: string; password: string };
      module: string;
      action: string;
      inputParams: Record<string, unknown>;
    },
  ): Promise<ActionResult<TData>> {
    if (typeof opts.as === "string") {
      await actAsUser.login(page, opts.as);
    } else {
      await actAsUser.loginAs(page, opts.as.email, opts.as.password);
    }

    const response = await page.request.post("/api/proof/invoke-action", {
      headers: {
        "x-proof-secret": getProofSecret(),
        "Content-Type": "application/json",
      },
      data: {
        module: opts.module,
        action: opts.action,
        inputParams: opts.inputParams,
      },
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `[PROOF_FAIL] action_invoke: response from /api/proof/invoke-action is not valid JSON (status ${response.status()})\n` +
          "  file: src/playwright/actAsUser.ts\n" +
          "  suggestion: The dev server likely returned an error page. Check server logs and confirm the route file at app/api/proof/invoke-action/route.ts is registered.",
      );
    }

    if (!response.ok()) {
      const harnessError = body as Partial<ActionInvokeErrorResponse>;
      throw new Error(
        `${typeof harnessError.error === "string" ? harnessError.error : `[PROOF_FAIL] action_invoke: harness request failed (status ${response.status()})`}\n` +
          "  file: src/playwright/actAsUser.ts\n" +
          `  suggestion: ${harnessError.suggestion ?? "Inspect /api/proof/invoke-action and confirm the action is registered and pipeline-wrapped."}`,
      );
    }

    if (!isActionResult<TData>(body)) {
      throw new Error(
        `[PROOF_FAIL] action_invoke: response body is not a valid ActionResult shape (status ${response.status()})\n` +
          `  file: src/playwright/actAsUser.ts\n` +
          `  body: ${JSON.stringify(body)}\n` +
          "  suggestion: The invoke route must always return { success, data } or { success: false, error }. Confirm PROOF_ACTION_REGISTRY contains the action and that it uses createAction().",
      );
    }

    return body;
  },

  /**
   * Return a Supabase client authenticated as the given user via
   * `signInWithPassword` against a *fresh* client (no cookies, no session
   * persistence). Queries made through the returned client run with that
   * user's RLS privileges.
   *
   * Use for server-side proofs where the browser is irrelevant and you want
   * direct evidence of whether the DB allows or denies a specific operation
   * for a specific user. This is the primitive behind the primary check in
   * `assert.tenantIsolation` and is intentionally exposed for specs that
   * need finer-grained RLS probes.
   */
  async supabaseClient(opts: {
    email: string;
    password: string;
  }): Promise<SupabaseClient> {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!url || !publishableKey) {
      throw new Error(
        "[PROOF_FAIL] config_missing: expected NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to be set, found one or both missing\n" +
          "  file: src/playwright/actAsUser.ts\n" +
          "  suggestion: Run setup-local-env.sh or load .env.local before running proof specs.",
      );
    }

    const client = createClient(url, publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      // Gateway 502s are retried at the transport, so every probe written
      // against this client — including ad-hoc ones in specs — is covered.
      global: { fetch: createRetryingFetch(`request as ${opts.email}`) },
    });

    const { error } = await retryAuthRateLimit(
      `signInWithPassword as ${opts.email}`,
      () =>
        client.auth.signInWithPassword({
          email: opts.email,
          password: opts.password,
        }),
      (result) => ({
        limited: isAuthRateLimited(result.error, result.error?.status),
      }),
    );
    if (error) {
      const category = isAuthRateLimited(error, error.status)
        ? "auth_rate_limited"
        : "auth_signin";
      throw new Error(
        `[PROOF_FAIL] ${category}: expected successful sign-in for ${opts.email}, found signInWithPassword error: ${error.message}\n` +
          "  file: src/playwright/actAsUser.ts\n" +
          `  suggestion: ${
            category === "auth_rate_limited"
              ? "The auth budget is exhausted, not the credentials. Wait for the window to reset or reduce parallel proof workers."
              : "Confirm the user was created by seed.user() and that password/email match."
          }`,
      );
    }

    return client;
  },
};
