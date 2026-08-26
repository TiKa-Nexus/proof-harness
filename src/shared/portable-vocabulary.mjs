// Import External Packages
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Portable proof vocabulary — the single source of truth for closed value
// lists that BOTH the TypeScript SDK and the dependency-free Node scripts
// (`proof_verify.mjs`, `proof_drift.mjs`, `proof_coverage.mjs`) must agree on.
//
// Why a .mjs file inside a TypeScript package: those scripts run under plain
// `node` with no compile step and must stay fast-starting, so they cannot
// import `vocabulary.ts`. Everything here is therefore plain JS, and the
// TypeScript side derives its union types from these arrays
// (`(typeof ACTION_CHANGE_KINDS)[number]` in mission-types.ts), so adding or
// renaming a value in exactly one place updates the validators, the drift
// script, coverage, and the types together. The JSDoc `@type {const}` casts
// are what preserve the literal element types for that derivation.
//
// Only vocabularies needed by the .mjs scripts live here; TS-only
// vocabularies stay in `vocabulary.ts`.
// ---------------------------------------------------------------------------

/**
 * Change kinds an `expectedChanges.actions[]` declaration may allow, and the
 * facets a modified action decomposes into. Like tables, EVERY facet of a
 * change must be declared for the change to be covered — a mission expecting
 * an invariant declaration to change does not thereby authorize an RBAC/auth
 * middleware change on the same action.
 *
 *   - `middleware_changed`: a scanner-observed guard (auth / tenantIsolation
 *     / rbac) appeared, disappeared, or flipped.
 *   - `invariants_changed`: the `withProof({ invariants })` list changed.
 *   - `service_role_mutations_changed`: the set of tables the action writes
 *     through the service-role client changed.
 *   - `metadata_changed`: verb, object, acceptsWorkspaceId, internalOnly, or
 *     usesDirectUpdateTag changed.
 */
export const ACTION_CHANGE_KINDS = /** @type {const} */ ([
  "added",
  "removed",
  "middleware_changed",
  "invariants_changed",
  "service_role_mutations_changed",
  "metadata_changed",
]);

/**
 * Change kinds an `expectedChanges.tables[]` declaration may allow, and the
 * facets a modified table decomposes into. Same coverage rule as actions:
 * declaring `columns_added` on a table does not authorize a policy change
 * that rode along on the same table.
 */
export const TABLE_CHANGE_KINDS = /** @type {const} */ ([
  "added",
  "removed",
  "columns_added",
  "columns_removed",
  "rls_classification_changed",
  "policies_changed",
]);

/**
 * The only helpers whose `emittedBy` stamp counts as tenant-isolation
 * evidence, split by target.
 *
 * Identity matters because helpers differ in who chooses the `kind`:
 * `assert.httpResponse` records the caller's kind verbatim, so its stamp on a
 * `tenant_isolation` assertion would prove only that an HTTP probe ran — not
 * that anything checked cross-tenant visibility. Isolation OF A TABLE is
 * exactly what `assert.tenantIsolation` proves, so table targets accept only
 * it; action-ref targets also accept `assert.authorization`, whose action
 * probes record the cross-tenant invariant they actually establish.
 */
export const TENANT_ISOLATION_TABLE_HELPERS = /** @type {const} */ ([
  "assert.tenantIsolation",
]);

/** Allowed stamps for tenant-isolation claims against non-table targets (action refs). */
export const TENANT_ISOLATION_ACTION_HELPERS = /** @type {const} */ ([
  "assert.tenantIsolation",
  "assert.authorization",
]);
