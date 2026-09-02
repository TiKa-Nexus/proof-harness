// Import External Packages
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Closed Vocabularies
//
// These are the ONLY allowed values for verb, kind, and rls_classification
// across the Proof system. Keeping them closed lets the scanner, manifest
// validator, and trace consumers all speak the same language.
// ---------------------------------------------------------------------------

/**
 * Verb — the action a capability performs.
 * Used as metadata in `withProof({ verb: ... })`.
 */
export const PROOF_VERBS = [
  "create",
  "read",
  "update",
  "delete",
  "invoke",
  "transfer",
] as const;

export type ProofVerb = (typeof PROOF_VERBS)[number];

/**
 * Kind — the category of a trace step / assertion.
 * Used in `trace_must_prove` manifest entries and emitted by `assert.*`
 * helpers and `trace.step({ kind })` calls.
 */
export const PROOF_KINDS = [
  "happy_path",
  "tenant_isolation",
  "authorization",
  "validation",
  "error_handling",
  "idempotency",
] as const;

export type ProofKind = (typeof PROOF_KINDS)[number];

/**
 * RLS classification — how a table is scoped under Row Level Security.
 * Emitted by the migration parser (v1). Defined here so v0.5 helpers and
 * future tooling share the same vocabulary.
 */
export const RLS_CLASSIFICATIONS = [
  "workspace_scoped",
  "user_scoped",
  "admin_only",
  "public_read",
  "service_only",
  "unclassified",
] as const;

export type RlsClassification = (typeof RLS_CLASSIFICATIONS)[number];

/**
 * The commands a Postgres RLS policy can cover, as the migration parser reports
 * them.
 *
 * `rls_classification` gives a table one label, which is a useful summary and a
 * poor description: real policies are per-command, so a table can be readable
 * only by admins while being writable only by the service role. `ALL` is Postgres'
 * own wildcard and matches every command, which is why a prohibition on any single
 * command has to consider it.
 */
export const POLICY_COMMANDS = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "ALL",
] as const;

export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isProofVerb(value: unknown): value is ProofVerb {
  return (
    typeof value === "string" &&
    (PROOF_VERBS as readonly string[]).includes(value)
  );
}

export function isProofKind(value: unknown): value is ProofKind {
  return (
    typeof value === "string" &&
    (PROOF_KINDS as readonly string[]).includes(value)
  );
}

export function isRlsClassification(
  value: unknown,
): value is RlsClassification {
  return (
    typeof value === "string" &&
    (RLS_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

export function isPolicyCommand(value: unknown): value is PolicyCommand {
  return (
    typeof value === "string" &&
    (POLICY_COMMANDS as readonly string[]).includes(value)
  );
}
