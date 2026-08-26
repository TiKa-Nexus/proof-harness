// Import External Packages
import { createClient } from "@supabase/supabase-js";
// Import Local Imports
import { createRetryingFetch } from "./transient";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Thin re-export of the service-role Supabase client, scoped to Proof.
//
// Proof helpers use the service-role client for two things:
//   1. Seed fixture setup (`seed.workspace`, `seed.user`)
//   2. Teardown of test data after assertions complete
//
// Consumers inside `.proof.ts` specs receive the result of this factory
// through the `setup({ sb })` callback of `assert.tenantIsolation`. They
// should NEVER construct a service-role client themselves — keeping the
// construction centralized makes it easy to add logging, usage limits, or
// a future mock in one place.
//
// This package does not depend on an application's generated database types or
// service-client wrapper. The factory reads the standard environment variables
// directly and gives proof-specific diagnostics.
// ---------------------------------------------------------------------------

function requireProofEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[PROOF_FAIL] missing_env: expected ${name}, found empty\n` +
        "  file: src/server/service-client.ts\n" +
        "  suggestion: Ensure CI exports the Supabase env vars before running pnpm proof:verify.",
    );
  }
  return value;
}

/**
 * Factory for a service-role Supabase client used inside Proof helpers and
 * `.proof.ts` spec files.
 *
 * Returns a service-role Supabase client so spec code can safely type the `sb`
 * parameter as the library's `SupabaseClient`.
 */
export function createProofServiceClient() {
  return createClient(
    requireProofEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireProofEnv("SUPABASE_SECRET_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      // Local Supabase sits behind Kong, which intermittently 502s under the
      // load of a proof run. Installing the retry here covers every query made
      // through this client, including ad-hoc ones inside proof specs.
      global: { fetch: createRetryingFetch("service-role request") },
    },
  );
}
