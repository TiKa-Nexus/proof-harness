// Import External Packages
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Proof action registry contract
//
// Applications own the generated `"<module>:<actionName>"` → handler map.
// The publishable package exports only the opaque handler type so a generated
// registry can be typed without pulling application actions into the package.
//
// The consumer implementation is generated from explicit withProof claims, derived
// service-role action requirements, and literal action probes in proof specs.
// It is consumed by `POST /api/proof/invoke-action` so Playwright specs can
// invoke a real server action end-to-end while authenticated as a specific user.
//
// Each registry entry is typed as an opaque handler because individual
// actions have different `inputParams` shapes. The route forwards the body's
// `inputParams` as-is; the action itself validates with Zod and returns an
// `ActionResult<T>`.
// ---------------------------------------------------------------------------

/**
 * Shape every entry in the registry conforms to. `inputParams` is
 * intentionally `unknown` — each action validates its own input at runtime
 * via Zod (see e.g. `RemoveMemberSchema` in `removeMember.ts`). The return
 * type is `unknown` because the `ActionResult<T>` generic varies per action;
 * callers narrow on `{ success: true, data }` in the proof spec.
 */
export type ProofActionHandler = (args: {
  inputParams: unknown;
  contextParams: { module: string; source: string };
}) => Promise<unknown>;
