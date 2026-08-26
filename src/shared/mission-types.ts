// ---------------------------------------------------------------------------
// Mission manifest types.
//
// A *mission manifest* is the JSON artifact an external consumer (Botstrap,
// or a developer in manual mode) writes to `.proof/current-mission.json` to
// tell `pnpm proof:verify` what the PR must prove. The validator at
// `packages/proof/src/node/validate-mission.ts` cross-references each
// requirement against the fresh `.proof/capabilities.json`, `.proof/schema.json`,
// and the aggregated trace.
//
// Shape is pinned by contract — additive changes bump nothing, breaking
// changes bump `schemaVersion` at the top of the manifest. Consumers should
// assert `schemaVersion === 1` and fail loudly otherwise.
// ---------------------------------------------------------------------------

import type { AssertionRole } from "./trace-types";
import {
  ACTION_CHANGE_KINDS,
  TABLE_CHANGE_KINDS,
} from "./portable-vocabulary.mjs";
import type {
  PolicyCommand,
  ProofKind,
  ProofVerb,
  RlsClassification,
} from "./vocabulary";

/**
 * Manifest schema version. Deliberately still 1 after the July 2026 validator
 * work: `trace_must_prove[].role` and `.proofId` are OPTIONAL additions, so
 * every v1 manifest is still shape-valid and consumers need not regenerate
 * anything. Note that validation did get stricter — a `control` assertion can
 * no longer satisfy a requirement — so a manifest that passed on a vacuous
 * probe before may now (correctly) fail. That is a behaviour tightening, not a
 * shape change, and bumping the version would have forced a rewrite of every
 * existing manifest for no benefit.
 */
export const MISSION_MANIFEST_SCHEMA_VERSION = 1;

export interface CapabilityRequirement {
  /** Matches `createAction({ functionName: <name> })` exactly. */
  name: string;
  /** Module folder name (e.g. `"issues"`, not `"__business-logic/issues"`). */
  module: string;
  /** One of PROOF_VERBS. */
  verb: ProofVerb;
  /** Free-form noun, lowercased by convention (e.g. `"issue"`, `"workspace"`). */
  object: string;
  /** Optional: invariants that the action's `withProof({ invariants })` must advertise. */
  invariants?: readonly string[];
}

export interface SchemaRequirement {
  /** Unqualified public-schema table name. */
  table: string;
  /** Columns that must exist on the table. Order-insensitive. */
  required_columns: readonly string[];
  /** One of RLS_CLASSIFICATIONS. */
  rls_classification: RlsClassification;
}

/**
 * "No policy on this table targets this role for these commands."
 *
 * Exists because `rls_classification` is one label per table and Postgres RLS is
 * per-command: `audit_logs` being "admin readable, service writable" cannot be
 * said with a single label, and the label a manifest picks would have to be a
 * lie in one direction or the other.
 *
 * Checks reachability, not the predicate — `USING` and `WITH CHECK` are not read.
 * A policy `TO authenticated USING (is_super_admin())` counts as targeting
 * `authenticated`, so "this role may act only under condition X" is not
 * expressible here and belongs in `trace_must_prove`, where something exercises
 * it. Write prohibitions ("members never INSERT into the audit log") are the
 * natural fit.
 *
 * Deliberately only the prohibition, never "a policy must exist". A policy's
 * existence is weak evidence — it says a rule was written, not that it works —
 * and the thing that makes a permission real is a passing proof, which belongs in
 * `trace_must_prove`. A prohibition is different: it is a claim that can fail
 * dangerously and silently, and it is checkable from the migrations alone.
 */
export interface PolicyProhibition {
  /** Unqualified public-schema table name. */
  table: string;
  /**
   * Database role that must not be granted access, e.g. `"authenticated"` or
   * `"anon"`. A policy with no `TO` clause defaults to `PUBLIC` in Postgres and
   * therefore counts as granting every role.
   */
  role: string;
  /**
   * Commands the prohibition covers. Omit to mean "any command". A policy
   * declared `FOR ALL` matches whatever is listed here, because that is what it
   * does in the database.
   */
  commands?: readonly PolicyCommand[];
  /** Human-readable statement of the rule, echoed in the failure message. */
  description: string;
}

export interface TraceRequirement {
  /** One of PROOF_KINDS. */
  kind: ProofKind;
  /**
   * Free-form identifier the assertion emits. Must match an assertion's
   * `target` exactly (e.g. table name for `tenant_isolation`, capability
   * name for `authorization`).
   */
  target: string;
  /** Human-readable statement of what should be proved. */
  description: string;
  /**
   * Which evidential role must satisfy this requirement. Defaults to
   * `"primary"`, which is almost always what you want: a `"control"`
   * assertion passes by design and proves only that the probe was capable of
   * failing, so it must never stand in for the claim itself.
   *
   * Accepts the deprecated spellings `"negative"` / `"positive_control"`.
   */
  role?: AssertionRole;
  /**
   * Optional: restrict matching to assertions emitted by this proof.
   *
   * By default a requirement may be satisfied by a matching assertion from
   * ANY proof in the run. That is convenient but means an unrelated spec can
   * unknowingly satisfy a mission's requirement. Set this when the mission
   * cares that a SPECIFIC proof made the claim. Either way, the aggregated
   * trace records which proof actually supplied the evidence.
   */
  proofId?: string;
  /**
   * What origin of assertion may satisfy this requirement.
   *
   *   - `"helper"` — only assertions stamped `emittedBy` by an SDK `assert.*`
   *     helper count. Helper assertions went through the SDK's vacuity
   *     controls and ground-truth re-reads; a spec-recorded assertion asserts
   *     whatever the spec wrote into it.
   *   - `"any"` — spec-recorded assertions (raw `recordAssertion`) count too.
   *     Those claims remain backstopped by the mutation inventory, which is
   *     why bespoke probes (RPC grants, column guards) stay expressible.
   *
   * `tenant_isolation` is always `"helper"`, and the stamp is additionally
   * identity-checked (see TENANT_ISOLATION_TABLE_HELPERS in trace-types):
   * declaring `evidence: "any"` for it is a `manifest_shape` error, so the
   * mission gate and strict coverage can never disagree about whether a raw
   * isolation assertion is admissible. Every other kind defaults to `"any"`.
   */
  evidence?: EvidenceOrigin;
}

/** Origin of assertion allowed to satisfy a `trace_must_prove` entry. */
export type EvidenceOrigin = "helper" | "any";

/**
 * The evidence origin a requirement demands, applying the kind-based default.
 * Consumed directly by the compiled validator used by `saasist-proof verify`.
 */
export function requiredEvidenceOrigin(
  kind: ProofKind,
  evidence: EvidenceOrigin | undefined,
): EvidenceOrigin {
  // Tenant isolation is helper-only regardless of what the manifest says: the
  // shape validator rejects `evidence: "any"` for it, and this belt-and-braces
  // keeps the matching honest even for a manifest that skipped shape checks.
  if (kind === "tenant_isolation") return "helper";
  return evidence ?? "any";
}

export interface MissionRequirements {
  capabilities_must_exist: readonly CapabilityRequirement[];
  schema_must_contain: readonly SchemaRequirement[];
  trace_must_prove: readonly TraceRequirement[];
  /**
   * Optional, so every existing v1 manifest stays shape-valid. Omitting it means
   * "no policy-level claims", not "policies are fine".
   */
  policies_must_not_allow?: readonly PolicyProhibition[];
}

/**
 * Change kinds an action declaration may allow. Like tables, a modified
 * action is decomposed into facets and EVERY facet must be covered — a
 * mission expecting an invariant declaration to change does not thereby
 * authorize an RBAC/auth middleware change on the same action.
 *
 * Derived from the single runtime source in
 * [`portable-vocabulary.mjs`](./portable-vocabulary.mjs), which the
 * dependency-free Node scripts import directly; see there for the per-facet
 * meanings.
 */
export type ActionChangeKind = (typeof ACTION_CHANGE_KINDS)[number];

/**
 * Change kinds a table declaration may allow. A "modified" table entry is
 * decomposed into facets, and EVERY facet must be covered by the declaration —
 * declaring `columns_added` on a table does not authorize a policy change on
 * the same table. Derived from `portable-vocabulary.mjs`.
 */
export type TableChangeKind = (typeof TABLE_CHANGE_KINDS)[number];

// Re-exported so TS consumers get the runtime lists from the same import
// site as the types they parameterize.
export { ACTION_CHANGE_KINDS, TABLE_CHANGE_KINDS };

/** Exact-ref action declaration. A bare string ref means "any change". */
export interface ExpectedActionChange {
  /** `<module>:<name>`, the same ref capabilities.json uses. */
  ref: string;
  /** Omit for "any change to this action". */
  changes?: readonly ActionChangeKind[];
}

/** Table declaration. A bare string name means "any tracked change". */
export interface ExpectedTableChange {
  name: string;
  /** Omit for "any tracked change to this table". */
  changes?: readonly TableChangeKind[];
}

/**
 * The proof-surface change budget a mission grants its PR.
 *
 * Everything else in the manifest states what MUST exist; this block bounds
 * what else MAY change on the surfaces drift tracks. Read by
 * the package drift engine, which diffs the regenerated
 * `capabilities.json` / `schema.json` / `package.json` / lockfile against the
 * PR's base and fails (`drift_undeclared`) on a high-severity delta outside
 * the declared budget.
 *
 * Scope is deliberately narrow-by-default:
 *
 *   - `modules` covers only ADDED actions in the named module (the
 *     new-module convenience). Modifying or removing an existing action is
 *     never authorized by a module declaration — a mission that expects a
 *     guard or signature change on an existing action must name the exact
 *     ref in `actions`, so "add a small feature" can never quietly license
 *     weakening an unrelated action in the same module.
 *   - String shorthands ("issues" in `tables`, "issues:createIssue" in
 *     `actions`) mean "any change" and are the coarse form; the object forms
 *     narrow to specific change kinds.
 *
 * Omitting the block keeps drift report-only, so every existing v1 manifest
 * behaves exactly as before.
 */
export interface ExpectedChanges {
  /**
   * Module leaf names (e.g. `"issues"`) in which NEW actions may appear.
   * Does not authorize modification or removal of existing actions.
   */
  modules?: readonly string[];
  /** Exact action refs that may change; see {@link ExpectedActionChange}. */
  actions?: readonly (string | ExpectedActionChange)[];
  /** Tables that may change; see {@link ExpectedTableChange}. */
  tables?: readonly (string | ExpectedTableChange)[];
  /**
   * Runtime dependencies (`package.json` `dependencies`) that may be added,
   * removed, or version-changed. Every runtime dependency delta is
   * high-severity — a swap or downgrade changes shipped behavior as surely as
   * an addition.
   */
  dependencies?: readonly string[];
  /**
   * Expect a lockfile-only resolution change (pnpm-lock.yaml differs while
   * the package.json dependency surface does not). Rare and suspicious by
   * default, hence explicitly declared rather than inferred.
   */
  lockfile?: boolean;
}

export interface MissionManifest {
  /** Pinned to MISSION_MANIFEST_SCHEMA_VERSION. */
  schemaVersion: number;
  /** Ticket id from the consumer's kanban (e.g. `"M-042"`). */
  missionId: string;
  /** Short human-readable title. */
  missionTitle: string;
  /** Product repo slug (informational). */
  productRepo?: string;
  /** PR branch name (informational). */
  prBranch?: string;
  /** ISO-8601 timestamp the manifest was generated. */
  createdAt: string;
  requirements: MissionRequirements;
  /**
   * Optional drift bound; see {@link ExpectedChanges}. Absent means the drift
   * report is informational only.
   */
  expectedChanges?: ExpectedChanges;
  /** Free-form notes for reviewers / the coding agent. */
  acceptanceNotes?: string;
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export type ValidationCategory =
  | "capability_missing"
  | "capability_mismatch"
  | "schema_missing"
  | "schema_column_missing"
  | "schema_rls_mismatch"
  /** A policy grants access the manifest declared must not exist. */
  | "schema_policy_permits"
  | "trace_missing"
  /**
   * A passing assertion matched the requirement but was recorded directly by
   * spec code (`recordAssertion`) where the requirement demands an SDK-helper
   * origin (`evidence: "helper"`, the default for `tenant_isolation`).
   */
  | "trace_unverified"
  | "manifest_shape"
  /** The Playwright run itself exited non-zero. Reported by the CLI, not the validator. */
  | "proof_run"
  /** The run produced no trace artifacts at all, so there is nothing to validate. */
  | "no_traces"
  /**
   * A trace in the directory was recorded against a different commit than the
   * current run — leftover evidence that cannot speak for the code under review.
   * Reported by the CLI, which knows the run's commit; the validator sees only
   * the bundle it is handed.
   */
  | "stale_trace";

/**
 * Which proof supplied the evidence for a satisfied `trace_must_prove` entry.
 *
 * Recorded for every requirement — satisfied or not — so a reviewer can audit
 * the mapping instead of trusting that "0 issues" meant the right proof made
 * the claim. Requirements are matched against all assertions in the run, so
 * without this the attribution would be invisible.
 */
export interface RequirementEvidence {
  kind: ProofKind;
  target: string;
  role: AssertionRole;
  satisfied: boolean;
  /** proofId of the trace whose assertion satisfied it, when satisfied. */
  proofId?: string;
  /** Spec file that produced that trace, when known. */
  specFile?: string;
  /** The satisfying assertion's `detail`, verbatim. */
  detail?: string;
  /**
   * The satisfying assertion's helper provenance, when it has one. Absent
   * means the evidence was recorded directly by spec code.
   */
  emittedBy?: string;
}

export interface ValidationIssue {
  category: ValidationCategory;
  /** Human-readable summary including expected vs found. */
  message: string;
  /** Structured context for machine consumers (optional). */
  context?: Record<string, unknown>;
}

export interface ValidationResult {
  missionId: string;
  ok: boolean;
  issues: ValidationIssue[];
  /** Attribution for every `trace_must_prove` entry, in manifest order. */
  evidence?: RequirementEvidence[];
}
