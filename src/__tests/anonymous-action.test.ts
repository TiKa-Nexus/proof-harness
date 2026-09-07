import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { actAsUser } from "../playwright/actAsUser";
import { authenticationRedirectResponse } from "../server/authentication-redirect";
const refusal = JSON.parse(
  fs.readFileSync(
    "proof-consumer-fixtures/action-invocation/auth-refusal.json",
    "utf8",
  ),
);
const originalSecret = process.env.API_SECRET_KEY;
afterEach(() => {
  if (originalSecret === undefined) delete process.env.API_SECRET_KEY;
  else process.env.API_SECRET_KEY = originalSecret;
});
it("normalizes only an anonymous redirect to an explicitly allowed authentication destination", async () => {
  const request = new Request("http://localhost/api/proof/invoke-action");
  const error = { digest: "NEXT_REDIRECT;replace;/login;307;" };
  const options = {
    module: "users",
    action: "selfDeleteAccount",
    allowedRedirects: ["/login"],
  };
  const response = authenticationRedirectResponse(error, request, options)!;
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual(refusal);
  expect(
    authenticationRedirectResponse(new Error("crash"), request, options),
  ).toBeNull();
  expect(
    authenticationRedirectResponse(
      { ...error, digest: "NEXT_REDIRECT;replace;/billing;307;" },
      request,
      options,
    ),
  ).toBeNull();
  expect(
    authenticationRedirectResponse(
      error,
      new Request(request, { headers: { cookie: "session=present" } }),
      options,
    ),
  ).toBeNull();
  expect(
    authenticationRedirectResponse(
      error,
      new Request(request, { headers: { authorization: "Bearer session" } }),
      options,
    ),
  ).toBeNull();
});
it.each([401, 500, 302])(
  "uses a fresh anonymous request context and refuses generic failure/redirect responses: %s",
  async (status) => {
    process.env.API_SECRET_KEY = "test-proof-key";
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers["x-proof-secret"]).toBe("test-proof-key");
      res.writeHead(status, {
        "content-type": "application/json",
        location: "/login",
      });
      res.end(
        JSON.stringify(
          status === 401 ? refusal : { success: false, error: "action_threw" },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const invocation = actAsUser.invokeAnonymousAction({} as Page, {
        module: "users",
        action: "selfDeleteAccount",
        inputParams: {},
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      if (status === 401) await expect(invocation).resolves.toEqual(refusal);
      else await expect(invocation).rejects.toThrow("unrecognized response");
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
