// Import External Packages
// Import Local Imports
import type { ProofKind } from "./vocabulary";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Trace artifact types
//
// These are the durable shape written to `.proof/traces/<proofId>.json`.
//
// Two separate identifiers on purpose:
//   - `proofId`    — per-file id; what _this_ proof verifies (e.g. "auth-login-admin",
//                    "workspace-invite-tenant-isolation"). The filename is keyed on it,
//                    so proofs never collide.
//   - `missionId`  — optional Botstrap ticket reference (e.g. "M-042"). A single mission
//                    typically has multiple proofs (happy_path + tenant_isolation +
//                    authorization), each with its own file. The v1 mission-manifest
//                    validator groups by `missionId` and checks that every
//                    `trace_must_prove` entry has at least one matching passing step
//                    across the group.
// ---------------------------------------------------------------------------

/**
 * The evidential role an assertion plays.
 *
 *   - `primary` — the claim the proof exists to make. For an authorization or
 *                 tenant-isolation proof that is a refusal ("the outsider could
 *                 NOT read the row"); for a happy_path proof it is a success
 *                 ("the user reached their workspace"). This is what a mission's
 *                 `trace_must_prove` entry matches by default.
 *   - `control` — a companion assertion proving the primary probe was capable of
 *                 failing at all: "the operation that SHOULD be permitted still
 *                 succeeded", or "the row the primary probe looked for genuinely
 *                 exists and is readable by someone."
 *
 * The distinction is load-bearing, not cosmetic. A refusal probe alone cannot
 * tell "RLS correctly hid this row" apart from "there was no row / the grant
 * denies everyone / the table name was a typo" — every one of those yields zero
 * rows and would record a passing assertion. The control is what makes the zero
 * mean something.
 *
 * Because the validator matches `trace_must_prove` on `{ kind, target,
 * passed: true }`, controls MUST be labelled: otherwise a control (which by
 * design passes) could satisfy a requirement all on its own and the primary
 * probe would never be checked at all.
 *
 * Naming note: an earlier draft called these `negative` / `positive_control`.
 * That reads backwards for `happy_path`, whose primary claim is a success, so
 * the roles are named by evidential function instead. Both older names are
 * accepted as deprecated aliases wherever a role is parsed.
 */
export type AssertionRole = "primary" | "control";

/**
 * Concrete operation exercised by an assertion. Mutation inventory keys claims
 * by kind + target + operation so a SELECT mutation cannot silently stand in
 * for an untested UPDATE/DELETE or action invocation.
 */
export type ProofOperation =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "invoke"
  | "request";

/** Deprecated role spellings accepted on input and normalized to AssertionRole. */
export const ASSERTION_ROLE_ALIASES: Readonly<Record<string, AssertionRole>> = {
  negative: "primary",
  positive_control: "control",
};

/**
 * Normalize a role from an artifact or manifest. `undefined` means `primary`:
 * traces written before schemaVersion 2 carry no role, and their assertions
 * were all primary claims.
 */
export function normalizeAssertionRole(role: unknown): AssertionRole | null {
  if (role === undefined || role === null) return "primary";
  if (role === "primary" || role === "control") return role;
  if (typeof role === "string" && role in ASSERTION_ROLE_ALIASES) {
    return ASSERTION_ROLE_ALIASES[role];
  }
  return null;
}

/**
 * What an assertion concluded.
 *
 * `passed` / `failed` are the two verdicts a boolean can carry. The other two
 * exist because "we did not find out" is a real outcome that a boolean has to
 * round to one side or the other, and rounding it to `false` is indistinguishable
 * from a genuine failure while rounding it to `true` is how a suite quietly stops
 * proving anything:
 *
 *   - `incomplete` — the probe ran but could not reach a verdict (a precondition
 *                    was missing, a dependency was unavailable).
 *   - `skipped`    — the probe was deliberately not run, e.g. a tenant-isolation
 *                    direction with no fixture rows on that side.
 *
 * Neither counts as evidence: both carry `passed: false`, so neither can satisfy
 * a mission requirement. The status is what lets a consumer tell them apart from
 * a real failure, and stops a skip from disappearing into "one fewer assertion".
 */
export type AssertionStatus = "passed" | "failed" | "incomplete" | "skipped";

/** Derive the status of an assertion that predates the field. */
export function normalizeAssertionStatus(
  status: unknown,
  passed: boolean,
): AssertionStatus {
  if (
    status === "passed" ||
    status === "failed" ||
    status === "incomplete" ||
    status === "skipped"
  ) {
    return status;
  }
  return passed ? "passed" : "failed";
}

/**
 * A single structured assertion recorded during a step. Produced by the
 * `assert.*` helpers via `recordAssertion(...)`. Hand-written `expect(...)`
 * calls inside a step do NOT appear here — only helper-driven assertions do,
 * because the v1 mission-manifest validator matches on
 * `{ kind, target, passed: true, role }` and needs a closed, machine-readable
 * surface.
 */
export interface TraceAssertion {
  /** Category from the closed `PROOF_KINDS` vocabulary. */
  kind: ProofKind;
  /** The thing asserted against: table, route, action, etc. */
  target: string;
  /** Concrete operation the probe exercised. */
  operation?: ProofOperation;
  /**
   * Whether this specific assertion held. Remains the authoritative field for
   * the validator and for consumers: only `true` is evidence.
   */
  passed: boolean;
  /**
   * Why `passed` has the value it has. Omitted is derived from `passed`, so
   * traces written before this field stay readable.
   */
  status?: AssertionStatus;
  /**
   * Evidential role. Omitted is treated as `"primary"` by the validator for
   * backward compatibility with traces written before schemaVersion 2.
   */
  role?: AssertionRole;
  /** Optional human-readable note for failure triage. */
  detail?: string;
  /**
   * Which SDK helper produced this assertion, e.g. `"assert.tenantIsolation"`.
   *
   * Stamped by the SDK itself through an internal channel that the public
   * `recordAssertion(...)` entry point cannot reach: a value supplied by spec
   * code is stripped before the assertion is recorded. Absent means the
   * assertion was recorded directly by a spec via `recordAssertion(...)`.
   *
   * The distinction is evidential. A helper-emitted assertion went through the
   * helper's vacuity controls, ground-truth re-reads, and role bookkeeping; a
   * spec-recorded assertion asserts whatever the spec chose to write into it.
   * The mission validator therefore requires helper provenance for
   * `tenant_isolation` requirements (a hand-rolled isolation probe has none of
   * `assert.tenantIsolation`'s protections), and a mission can demand it for
   * any requirement via `trace_must_prove[].evidence: "helper"`.
   *
   * For `tenant_isolation` the stamp is also identity-checked, not merely
   * present-checked — see TENANT_ISOLATION_TABLE_HELPERS. `assert.httpResponse`
   * records whatever `kind` its caller passes, so "some helper emitted this"
   * is not the same claim as "the isolation probe ran".
   */
  emittedBy?: string;
}

/**
 * The only helpers whose stamp counts as tenant-isolation evidence, split by
 * target (tables are stricter than action refs). The single runtime source is
 * [`portable-vocabulary.mjs`](./portable-vocabulary.mjs), which the
 * dependency-free Node scripts (`proof_verify.mjs`, `proof_coverage.mjs`)
 * import directly; see there for the identity rationale.
 */
export {
  TENANT_ISOLATION_ACTION_HELPERS,
  TENANT_ISOLATION_TABLE_HELPERS,
} from "./portable-vocabulary.mjs";

/**
 * A single step inside a proof.
 * Produced by `t.step({ intent, kind, target }, async () => { ... })`.
 */
export interface TraceStep {
  /** Human-readable description of what the step attempted. */
  intent: string;
  /** Category of the step, from closed vocabulary. */
  kind: ProofKind;
  /** The thing the step targets: action name, table, route, etc. */
  target: string;
  /** What the step observed (returned by the step callback). */
  observation: string;
  /** Whether the step's assertions held. */
  passed: boolean;
  /** Optional: who the step acted as (email, role, seed identifier). */
  actor?: string;
  /** Optional: which workspace the step operated in. */
  workspaceId?: string;
  /** Wall-clock duration of the step callback. */
  durationMs: number;
  /** On failure, the error message captured. */
  error?: string;
  /**
   * Structured assertions recorded by `assert.*` helpers during this step.
   * Empty or omitted for steps that only use `expect(...)` directly.
   * The v1 mission-manifest validator matches `trace_must_prove` entries
   * against this array.
   */
  assertions?: TraceAssertion[];
}

/**
 * Current per-proof trace artifact schema version.
 *
 * 2 — adds `role` and `status` to assertions and the `schemaVersion` /
 *     `specFile` / `specHash` / `commit` / `dirty` provenance fields below.
 *     Consumers written against v1 keep working: every v1 field is still present
 *     with the same meaning, and both new assertion fields are derivable when
 *     absent.
 *
 * `commit`, `dirty`, and `mutation` arrived after v2 shipped and did not bump
 * it: they are optional additions, and the contract's rule is that additive
 * fields do not move a version. A consumer that needs them must treat absence
 * as "unknown" anyway, since normal runs have no mutation and a non-git
 * checkout cannot supply code provenance.
 */
export const TRACE_ARTIFACT_SCHEMA_VERSION = 2;

/**
 * Provenance attached only when the mutation harness deliberately plants a
 * defect. A red mutation trace means the check detected the named defect; it
 * must never be mistaken for a real application regression.
 */
export interface TraceMutation {
  /** Stable mutation identifier from the repository-owned mutation catalog. */
  id: string;
  /** Always true; makes the intentional nature explicit to copied consumers. */
  planted: true;
}

/**
 * A trace artifact — one proof's worth of evidence.
 * Written atomically to `.proof/traces/<proofId>.json` when the proof
 * completes (pass or fail).
 */
export interface TraceArtifact {
  /**
   * Pinned to TRACE_ARTIFACT_SCHEMA_VERSION. Absent on traces written by
   * SDK versions before provenance was added.
   */
  schemaVersion?: number;
  /**
   * Repo-relative path of the spec file that produced this trace, e.g.
   * `e2e/proofs/workspace-invite.proof.ts`. Lets a reviewer go from a claim
   * straight to the code that made it.
   */
  specFile?: string;
  /**
   * First 12 hex chars of the SHA-256 of the spec file's contents. Two runs
   * claiming the same proof with different hashes were produced by different
   * code — which is the whole question when a previously-red proof turns
   * green.
   */
  specHash?: string;
  /**
   * Full SHA of the commit that was checked out while the proof ran. `specHash`
   * pins the spec that made the claim; this pins the application it was made
   * against, which is what lets an external ledger say "red at X, green at Y".
   *
   * Absent outside a git checkout. On a CI `pull_request` run this is the
   * ephemeral merge commit the checkout created — accurate about what was
   * tested, but not a commit you can return to later.
   */
  commit?: string;
  /**
   * Whether the working tree had uncommitted changes when the proof ran. A pass
   * from a dirty tree is evidence about code that exists nowhere but one laptop,
   * so a consumer gating on traces should be able to refuse it. Absent when it
   * could not be determined, which is not the same as `false`.
   */
  dirty?: boolean;
  /**
   * Present only for intentional red runs produced by `proof:mutate`.
   * Stored inside the trace so provenance survives artifact renames/copies.
   */
  mutation?: TraceMutation;
  /**
   * Per-file identifier for this proof. Used as the filename stem and as the
   * join key when the v1 mission-manifest validator looks for a matching
   * passing step for a `trace_must_prove` entry.
   */
  proofId: string;
  /**
   * Optional reference to the Botstrap mission (ticket) this proof belongs
   * to. Multiple proofs share one `missionId`. Absent in v0.5 local runs
   * that are not tied to a mission.
   */
  missionId?: string;
  /** ISO 8601 timestamp of proof start. */
  timestamp: string;
  /** Total wall-clock duration across all steps. */
  durationMs: number;
  /** True only if every step passed. */
  passed: boolean;
  /** Ordered list of steps as they were executed. */
  steps: TraceStep[];
}

/**
 * Options accepted by `trace.proof(...)`. A bare string is treated as
 * `{ proofId: string }` — the common v0.5 case where no mission is attached.
 */
export interface ProofOptions {
  proofId: string;
  missionId?: string;
}

/**
 * The handle passed to a proof callback. Provides the step recorder.
 */
export interface TraceRecorder {
  step<T extends StepResult | void>(
    opts: StepOptions,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface StepOptions {
  intent: string;
  kind: ProofKind;
  target: string;
  actor?: string;
  workspaceId?: string;
}

/**
 * Optional payload returned by a step callback. If the callback returns
 * `void` the step is still recorded with `observation: ""`.
 */
export interface StepResult {
  observation?: string;
}
