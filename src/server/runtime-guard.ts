// Import External Packages
import { NextResponse } from "next/server.js";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Runtime guard for /api/proof/* routes.
//
// The Proof runtime endpoints (seed-login, later capabilities/schema) exist
// only to support local verification runs and CI. They must never be usable
// in production builds aimed at end users.
//
// Guarded by two gates:
//   1. Environment: NODE_ENV === "development" OR PROOF_MODE === "true"
//   2. Shared secret: x-proof-secret header must match API_SECRET_KEY
//
// The secret gate reuses the existing API_SECRET_KEY rather than introducing
// a new env var — one fewer thing to configure per environment.
// ---------------------------------------------------------------------------

interface GuardRejection {
  error: string;
  suggestion: string;
}

/**
 * Check whether a request is allowed to hit a /api/proof/* route.
 *
 * @returns `null` when the request may proceed, or a `Response` to return
 *          directly (403) when the request must be blocked.
 */
export function proofGuard(request: Request): Response | null {
  const envOk =
    process.env.NODE_ENV === "development" || process.env.PROOF_MODE === "true";

  if (!envOk) {
    return jsonError(403, {
      error:
        "[PROOF_FAIL] guard_env: proof endpoints are disabled in this environment",
      suggestion:
        "Run against a dev server (NODE_ENV=development) or set PROOF_MODE=true on the server.",
    });
  }

  const expected = process.env.API_SECRET_KEY;
  if (!expected) {
    return jsonError(500, {
      error: "[PROOF_FAIL] guard_secret_missing: API_SECRET_KEY is not set",
      suggestion:
        "Set API_SECRET_KEY in the server environment. Proof helpers use it as the shared secret for /api/proof/* routes.",
    });
  }

  const provided = request.headers.get("x-proof-secret");
  if (provided !== expected) {
    return jsonError(403, {
      error:
        "[PROOF_FAIL] guard_secret: x-proof-secret header missing or invalid",
      suggestion:
        "The runner's API_SECRET_KEY does not match the dev server. If .env.local changed after the server started, restart that server; proof helpers already send the current key in x-proof-secret.",
    });
  }

  return null;
}

function jsonError(status: number, body: GuardRejection): Response {
  return NextResponse.json(body, { status });
}
