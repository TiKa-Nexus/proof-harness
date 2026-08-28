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

/**
 * Hosts that are unmistakably this machine. Matched against the PARSED
 * hostname, never by substring — `https://localhost.example.com` must not
 * pass. `[::1]` is how Node's URL reports an IPv6 loopback hostname; the
 * bare form is kept for defense in depth.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const extraAllowedHosts = new Set<string>();

/**
 * Explicitly allow additional Supabase hostnames for proof runs — for CI
 * setups where the disposable stack lives on a docker-network hostname
 * (`kong`, `supabase-db`, …) rather than localhost.
 *
 * This is deliberately a code-level API with no environment-variable
 * equivalent: the proof suite DELETES auth users and workspaces, so widening
 * its blast radius should cost a reviewable code change, not an env var
 * someone sets once to unblock themselves and never unsets.
 */
export function allowProofServiceHosts(hosts: readonly string[]): void {
  for (const host of hosts) {
    extraAllowedHosts.add(host.toLowerCase());
  }
}

/**
 * Returns why `rawUrl` must not be used for a proof run, or null when it is
 * safe. Exported so consumers who build their own clients can compose the
 * same check.
 */
export function proofServiceHostProblem(
  rawUrl: string,
  allowedHosts: ReadonlySet<string> = extraAllowedHosts,
): string | null {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return `NEXT_PUBLIC_SUPABASE_URL is not a parseable URL (${JSON.stringify(rawUrl)}), so it cannot be verified as local`;
  }
  if (LOCAL_HOSTS.has(hostname) || allowedHosts.has(hostname)) return null;
  return `NEXT_PUBLIC_SUPABASE_URL points at a non-local Supabase (host: ${hostname})`;
}

/**
 * The suite this client serves deletes auth users and workspaces and assumes
 * a database that can be reset between runs. Against a hosted project that is
 * all real and none of it recoverable — and the failure is silent: the run
 * passes, and the accounts are gone. So a non-local target is a hard abort,
 * mirroring assertLocalDatabase() in the mutation engine.
 */
function assertProofServiceUrlIsSafe(rawUrl: string): void {
  const problem = proofServiceHostProblem(rawUrl);
  if (!problem) return;
  throw new Error(
    `[PROOF_FAIL] unsafe_database: expected a local Supabase target, found ${problem}\n` +
      "  file: src/server/service-client.ts\n" +
      "  suggestion: The proof suite seeds and DELETES auth users and workspaces, so it refuses " +
      "every non-local database. Point NEXT_PUBLIC_SUPABASE_URL at a local stack " +
      "(pnpm exec supabase start). A genuinely disposable non-local host (for example a " +
      "docker-network hostname in CI) must be allowed in code via allowProofServiceHosts([...]); " +
      "there is deliberately no environment-variable override.",
  );
}

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
  const url = requireProofEnv("NEXT_PUBLIC_SUPABASE_URL");
  assertProofServiceUrlIsSafe(url);
  return createClient(
    url,
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
