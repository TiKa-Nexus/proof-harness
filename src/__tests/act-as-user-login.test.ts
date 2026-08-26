// Import External Packages
import type { APIResponse, Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import Local Imports
import { actAsUser } from "../playwright/actAsUser";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

function response(
  status: number,
  body: unknown,
  retryAfter?: string,
): APIResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    statusText: () => (status === 429 ? "Too Many Requests" : "Unauthorized"),
    headers: () => (retryAfter ? { "retry-after": retryAfter } : {}),
    json: async () => body,
  } as unknown as APIResponse;
}

function pageWith(...responses: APIResponse[]): {
  page: Page;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn();
  for (const value of responses) post.mockResolvedValueOnce(value);
  return {
    post,
    page: {
      request: { post },
      url: () => "about:blank",
      reload: vi.fn(),
    } as unknown as Page,
  };
}

beforeEach(() => {
  process.env.API_SECRET_KEY = "test-secret";
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.API_SECRET_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("proof login rate-limit diagnostics", () => {
  it("honors bounded Retry-After and succeeds on a later attempt", async () => {
    const { page, post } = pageWith(
      response(429, { error: "[PROOF_FAIL] auth_rate_limited: wait" }, "0.001"),
      response(200, {
        ok: true,
        userId: "admin-id",
        email: "dev-admin@example.com",
      }),
    );

    const login = actAsUser.login(page, "admin");
    await vi.runAllTimersAsync();
    await expect(login).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("reports exhausted HTTP 429 as auth_rate_limited", async () => {
    const limited = () =>
      response(
        429,
        {
          error: "[PROOF_FAIL] auth_rate_limited: budget exhausted",
          suggestion: "Wait for the auth window.",
        },
        "0.001",
      );
    const { page, post } = pageWith(limited(), limited(), limited());

    const login = actAsUser.login(page, "admin");
    const rejection = expect(login).rejects.toThrow(
      "[PROOF_FAIL] auth_rate_limited:",
    );
    await vi.runAllTimersAsync();
    await rejection;
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("does not retry an ordinary credential failure", async () => {
    const { page, post } = pageWith(
      response(401, {
        error: "[PROOF_FAIL] auth_signin: invalid credentials",
        suggestion: "Check the seeded user.",
      }),
    );

    await expect(actAsUser.login(page, "member")).rejects.toThrow(
      "[PROOF_FAIL] auth_signin:",
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
});
