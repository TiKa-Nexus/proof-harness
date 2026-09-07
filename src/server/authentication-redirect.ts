import { isRedirectError } from "next/dist/client/components/redirect-error.js";
import type { ActionAuthenticationRefusal } from "../shared/action-types";

/** Call only inside the guarded invoker's catch, after executing a registered action. */
export function authenticationRedirectResponse(
  error: unknown,
  request: Request,
  options: {
    module: string;
    action: string;
    allowedRedirects: readonly string[];
  },
): Response | null {
  // The adapter is only for anonymous requests. It does not turn a logged-in
  // user's application redirect or arbitrary exception into an auth denial.
  if (request.headers.get("cookie") || request.headers.get("authorization"))
    return null;
  if (!isRedirectError(error)) return null;
  const destination = error.digest.split(";").slice(2, -2).join(";");
  if (
    !destination.startsWith("/") ||
    destination.startsWith("//") ||
    !options.allowedRedirects.includes(destination)
  )
    return null;
  const body: ActionAuthenticationRefusal = {
    protocolVersion: 1,
    type: "proof_action_auth_refusal",
    module: options.module,
    action: options.action,
    reason: "authentication_required",
    redirect: destination,
  };
  return Response.json(body, { status: 401 });
}
