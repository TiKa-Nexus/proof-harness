// Server-side entry point for the Proof SDK.
//
// Safe to import from Next.js API routes AND from the Playwright test runner
// process. Intentionally does NOT use the `server-only` package — Playwright
// specs need `seed.*` and `createProofServiceClient` at test setup time, and
// those run in plain Node (where `server-only` throws because the
// `react-server` export condition isn't set).
//
// The gate is the service-role key in process.env, not a bundler directive.

export { proofGuard } from "./runtime-guard";
export { seed } from "./seed";
export { createProofServiceClient } from "./service-client";
export {
  AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  AUTH_RATE_LIMIT_MAX_DELAY_MS,
  AUTH_RATE_LIMIT_MAX_TOTAL_WAIT_MS,
  clampAuthRateLimitDelay,
  isAuthRateLimited,
  parseRetryAfterMs,
  retryAuthRateLimit,
} from "./auth-rate-limit";
export {
  ProofFixturePendingError,
  defineProofFixture,
  isProofFixturePendingError,
  pendingProofFixture,
} from "./fixture";
export type { ProofActionHandler } from "./action-registry";
export type { AuthRateLimitErrorLike } from "./auth-rate-limit";
export type {
  DefineProofFixtureOptions,
  ProofFixtureContext,
  ProofFixtureFactory,
} from "./fixture";
export type { SeedWorkspace, SeedUser } from "./seed";
