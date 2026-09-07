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

/** Auth refusal emitted only by the protected invoker's redirect adapter. */
export interface ActionAuthenticationRefusal {
  protocolVersion: 1;
  type: "proof_action_auth_refusal";
  module: string;
  action: string;
  reason: "authentication_required";
  redirect: string;
}

export function isActionAuthenticationRefusal(
  value: unknown,
): value is ActionAuthenticationRefusal {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<ActionAuthenticationRefusal>;
  return (
    body.protocolVersion === 1 &&
    body.type === "proof_action_auth_refusal" &&
    body.reason === "authentication_required" &&
    typeof body.module === "string" &&
    typeof body.action === "string" &&
    typeof body.redirect === "string"
  );
}
