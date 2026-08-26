// ---------------------------------------------------------------------------
// Shared action-invocation types
//
// Mirrors the shape returned by `createAction` in `@shared/middleware/src/utils/pipeline`.
// We redefine it in the `proof` package so Playwright-side helpers don't have
// to import from middleware (which transitively pulls in Next-only code).
// The two definitions must stay structurally equivalent.
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by every server action that uses the
 * `createAction` pipeline. Identical in shape to `ActionResult<T>` in
 * `@shared/middleware`.
 */
export type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Body accepted by `POST /api/proof/invoke-action`.
 *
 * `module` + `action` together form the registry key (`"module:action"`).
 * `inputParams` is passed through as-is; each action validates its own shape
 * with Zod at runtime.
 */
export interface InvokeActionRequest {
  module: string;
  action: string;
  inputParams: Record<string, unknown>;
}
