// Playwright-facing entry point for the Proof SDK.
//
// Imported by `e2e/proofs/*.proof.ts` files. Must not import server-only
// modules or depend on service-role secrets directly — those live in
// the server entry point and run inside `seed.*` / `assert.*` helpers.

export { actAsUser } from "./actAsUser";
export { assert } from "./assert";
export { trace, recordAssertion } from "./trace";
