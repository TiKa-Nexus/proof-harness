// ---------------------------------------------------------------------------
// Mission manifest validator.
//
// Three-way cross-reference:
//   1. Manifest is shape-correct (schemaVersion + required fields).
//   2. Every `capabilities_must_exist[i]` is found in `.proof/capabilities.json`.
//   3. Every `schema_must_contain[i]` is found in `.proof/schema.json` with
//      matching required_columns and rls_classification.
//   4. No policy in `.proof/schema.json` grants what a
//      `policies_must_not_allow[i]` entry forbids. This is the per-command view
//      that `rls_classification`'s single label per table cannot express.
//   5. Every `trace_must_prove[i]` has at least one passing assertion in the
//      aggregated trace with matching `kind` + `target` + `role` (default
//      `primary`), optionally pinned to a specific `proofId`. Which proof
//      supplied each piece of evidence is reported back in `evidence` so the
//      attribution is auditable rather than implicit.
//
// Produces a structured ValidationResult; the CLI driver is responsible for
// formatting to `[PROOF_FAIL]` lines and exit codes.
//
// Intentionally zero runtime dependencies — this file runs under Node during
// `pnpm proof:verify` and inside CI, and must stay fast-starting.
// ---------------------------------------------------------------------------

import {
  ACTION_CHANGE_KINDS,
  MISSION_MANIFEST_SCHEMA_VERSION,
  requiredEvidenceOrigin,
  TABLE_CHANGE_KINDS,
  type MissionManifest,
  type RequirementEvidence,
  type ValidationIssue,
  type ValidationResult,
} from "../shared/mission-types";
import {
  isPolicyCommand,
  isProofKind,
  isProofVerb,
  isRlsClassification,
} from "../shared/vocabulary";
import {
  normalizeAssertionRole,
  TENANT_ISOLATION_ACTION_HELPERS,
  TENANT_ISOLATION_TABLE_HELPERS,
  type TraceArtifact,
  type TraceAssertion,
} from "../shared/trace-types";

// ---------------------------------------------------------------------------
// External artifact shapes (only the fields we need)
// ---------------------------------------------------------------------------

export interface CapabilitiesArtifact {
  schemaVersion: number;
  capabilities: Array<{
    name: string;
    module: string;
    /** Literal exported wrapper function used by the generated invoke registry. */
    exportName?: string | null;
    verb: string | null;
    object: string | null;
    invariants: readonly string[];
    /** Derived scanner signal; absent on older additive v1 artifacts. */
    acceptsWorkspaceId?: boolean;
    /** Internal BOT/server-only plumbing is not a user-invoked boundary. */
    internalOnly?: boolean;
    /** Direct next/cache updateTag is not safe through the proof route. */
    usesDirectUpdateTag?: boolean;
    /** Concrete writes issued through createSupabaseServiceClient(). */
    serviceRoleMutations?: ReadonlyArray<{
      table: string;
      operation: "insert" | "upsert" | "update" | "delete";
    }>;
    /** Relevant guards observed in the action pipeline. */
    middleware?: {
      auth: boolean;
      tenantIsolation: boolean;
      rbac: boolean;
    };
    file: string;
  }>;
  unclassified?: readonly unknown[];
}

export interface SchemaPolicy {
  name: string;
  /** One of POLICY_COMMANDS as the parser reports it. */
  command: string;
  /** Roles from the policy's `TO` clause. Empty means no clause, i.e. PUBLIC. */
  roles: readonly string[];
}

export interface SchemaArtifact {
  schemaVersion: number;
  tables: Array<{
    name: string;
    columns: readonly string[];
    rls_classification: string;
    policies: readonly SchemaPolicy[];
    sourceFiles: readonly string[];
  }>;
  unclassified?: readonly unknown[];
}

/**
 * A trace bundle for validation is the aggregated list of every trace the
 * proof run emitted. Kept as `TraceArtifact[]` so v0.6's per-proof JSON
 * files can be concatenated without transformation.
 */
export type TraceBundle = readonly TraceArtifact[];

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate the optional `expectedChanges` block. Kept separate because the
 * shape has real structure (string shorthands vs narrowing objects) and a
 * malformed budget must fail loudly rather than half-enforce.
 */
function expectedChangesShapeIssues(block: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (block === undefined) return issues;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    issues.push({
      category: "manifest_shape",
      message: "expectedChanges must be an object when present",
    });
    return issues;
  }
  const changes = block as Record<string, unknown>;

  for (const key of ["modules", "dependencies"] as const) {
    const list = changes[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every(isNonEmptyString)) {
      issues.push({
        category: "manifest_shape",
        message: `expectedChanges.${key} must be an array of non-empty strings when present`,
      });
    }
  }

  const validateEntryList = (
    key: "actions" | "tables",
    nameField: "ref" | "name",
    kinds: readonly string[],
  ) => {
    const list = changes[key];
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      issues.push({
        category: "manifest_shape",
        message: `expectedChanges.${key} must be an array when present`,
      });
      return;
    }
    for (const entry of list) {
      if (isNonEmptyString(entry)) continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push({
          category: "manifest_shape",
          message: `expectedChanges.${key} entries must be non-empty strings or { ${nameField}, changes? } objects`,
        });
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (!isNonEmptyString(record[nameField])) {
        issues.push({
          category: "manifest_shape",
          message: `expectedChanges.${key}[].${nameField} is required (non-empty string)`,
        });
      }
      if (record.changes !== undefined) {
        if (
          !Array.isArray(record.changes) ||
          record.changes.length === 0 ||
          !record.changes.every((c) => kinds.includes(c as string))
        ) {
          issues.push({
            category: "manifest_shape",
            message: `expectedChanges.${key}[].changes must be a non-empty array drawn from: ${kinds.join(", ")}`,
          });
        }
      }
    }
  };
  validateEntryList("actions", "ref", ACTION_CHANGE_KINDS);
  validateEntryList("tables", "name", TABLE_CHANGE_KINDS);

  if (changes.lockfile !== undefined && typeof changes.lockfile !== "boolean") {
    issues.push({
      category: "manifest_shape",
      message: "expectedChanges.lockfile must be a boolean when present",
    });
  }

  return issues;
}

function shapeIssues(manifest: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!manifest || typeof manifest !== "object") {
    issues.push({
      category: "manifest_shape",
      message: "manifest is not a JSON object",
    });
    return issues;
  }
  const m = manifest as Partial<MissionManifest>;

  if (m.schemaVersion !== MISSION_MANIFEST_SCHEMA_VERSION) {
    issues.push({
      category: "manifest_shape",
      message: `expected schemaVersion=${MISSION_MANIFEST_SCHEMA_VERSION}, found ${String(m.schemaVersion)}`,
    });
  }
  if (typeof m.missionId !== "string" || m.missionId.length === 0) {
    issues.push({
      category: "manifest_shape",
      message: "missionId is required (non-empty string)",
    });
  }
  if (typeof m.missionTitle !== "string" || m.missionTitle.length === 0) {
    issues.push({
      category: "manifest_shape",
      message: "missionTitle is required (non-empty string)",
    });
  }
  if (typeof m.createdAt !== "string" || m.createdAt.length === 0) {
    issues.push({
      category: "manifest_shape",
      message: "createdAt is required (ISO-8601 string)",
    });
  }

  // Optional drift bound: absent is fine, present-but-wrong is not — a typo'd
  // scope list would otherwise silently disable the enforcement it names.
  issues.push(...expectedChangesShapeIssues(m.expectedChanges));

  const req = m.requirements;
  if (!req || typeof req !== "object") {
    issues.push({
      category: "manifest_shape",
      message: "requirements block is required",
    });
    return issues;
  }
  if (!Array.isArray(req.capabilities_must_exist)) {
    issues.push({
      category: "manifest_shape",
      message: "requirements.capabilities_must_exist must be an array",
    });
  }
  if (!Array.isArray(req.schema_must_contain)) {
    issues.push({
      category: "manifest_shape",
      message: "requirements.schema_must_contain must be an array",
    });
  }
  if (!Array.isArray(req.trace_must_prove)) {
    issues.push({
      category: "manifest_shape",
      message: "requirements.trace_must_prove must be an array",
    });
  }
  // Optional block: absent is fine, present-but-wrong is not.
  if (
    req.policies_must_not_allow !== undefined &&
    !Array.isArray(req.policies_must_not_allow)
  ) {
    issues.push({
      category: "manifest_shape",
      message:
        "requirements.policies_must_not_allow must be an array when present",
    });
  }

  // Vocabulary checks (best-effort — don't fail if fields are missing since
  // shape errors above will already have been reported).
  for (const cap of req.capabilities_must_exist ?? []) {
    if (!isProofVerb((cap as { verb?: unknown }).verb)) {
      issues.push({
        category: "manifest_shape",
        message: `capabilities_must_exist[].verb "${String((cap as { verb?: unknown }).verb)}" is not in PROOF_VERBS`,
      });
    }
  }
  for (const s of req.schema_must_contain ?? []) {
    if (
      !isRlsClassification(
        (s as { rls_classification?: unknown }).rls_classification,
      )
    ) {
      issues.push({
        category: "manifest_shape",
        message: `schema_must_contain[].rls_classification "${String((s as { rls_classification?: unknown }).rls_classification)}" is not in RLS_CLASSIFICATIONS`,
      });
    }
  }
  for (const t of req.trace_must_prove ?? []) {
    if (!isProofKind((t as { kind?: unknown }).kind)) {
      issues.push({
        category: "manifest_shape",
        message: `trace_must_prove[].kind "${String((t as { kind?: unknown }).kind)}" is not in PROOF_KINDS`,
      });
    }
    const evidence = (t as { evidence?: unknown }).evidence;
    if (evidence !== undefined && evidence !== "helper" && evidence !== "any") {
      issues.push({
        category: "manifest_shape",
        message: `trace_must_prove[].evidence "${String(evidence)}" is not a valid evidence origin; expected "helper" or "any"`,
      });
    }
    // Tenant isolation admits no opt-out: strict coverage rejects raw
    // isolation assertions unconditionally, and the mission gate must never
    // accept what coverage refuses. Bespoke escapes live in mutation policy,
    // not here.
    if (
      evidence === "any" &&
      (t as { kind?: unknown }).kind === "tenant_isolation"
    ) {
      issues.push({
        category: "manifest_shape",
        message:
          'trace_must_prove[].evidence "any" is not allowed for kind "tenant_isolation"; isolation evidence must come from an SDK helper (assert.tenantIsolation, or assert.authorization for action targets)',
      });
    }
  }
  for (const p of Array.isArray(req.policies_must_not_allow)
    ? req.policies_must_not_allow
    : []) {
    const prohibition = p as { role?: unknown; commands?: unknown };
    if (typeof prohibition.role !== "string" || prohibition.role.length === 0) {
      issues.push({
        category: "manifest_shape",
        message:
          "policies_must_not_allow[].role is required (non-empty database role name)",
      });
    }
    // A typo'd command would otherwise match nothing and pass, turning a
    // security claim into a comment.
    if (prohibition.commands !== undefined) {
      if (!Array.isArray(prohibition.commands)) {
        issues.push({
          category: "manifest_shape",
          message:
            "policies_must_not_allow[].commands must be an array when present",
        });
      } else {
        for (const command of prohibition.commands) {
          if (!isPolicyCommand(command)) {
            issues.push({
              category: "manifest_shape",
              message: `policies_must_not_allow[].commands entry "${String(command)}" is not in POLICY_COMMANDS`,
            });
          }
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Cross-reference checks
// ---------------------------------------------------------------------------

function checkCapabilities(
  manifest: MissionManifest,
  capabilities: CapabilitiesArtifact,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const req of manifest.requirements.capabilities_must_exist) {
    const match = capabilities.capabilities.find(
      (c) => c.name === req.name && c.module === req.module,
    );
    if (!match) {
      issues.push({
        category: "capability_missing",
        message: `expected capability ${req.module}:${req.name} (verb=${req.verb}, object=${req.object}); not found in capabilities.json`,
        context: { requirement: req },
      });
      continue;
    }
    if (match.verb !== req.verb) {
      issues.push({
        category: "capability_mismatch",
        message: `capability ${req.module}:${req.name} has verb="${match.verb ?? "<missing>"}" but manifest requires "${req.verb}"; add or update withProof({ verb }) on the action`,
        context: { requirement: req, found: match },
      });
    }
    if (req.object && match.object !== req.object) {
      issues.push({
        category: "capability_mismatch",
        message: `capability ${req.module}:${req.name} has object="${match.object ?? "<missing>"}" but manifest requires "${req.object}"; add or update withProof({ object }) on the action`,
        context: { requirement: req, found: match },
      });
    }
    if (req.invariants && req.invariants.length > 0) {
      const missing = req.invariants.filter(
        (inv) => !match.invariants.includes(inv),
      );
      if (missing.length > 0) {
        issues.push({
          category: "capability_mismatch",
          message: `capability ${req.module}:${req.name} is missing invariants: ${missing.join(", ")}; add them to withProof({ invariants })`,
          context: { requirement: req, found: match, missing },
        });
      }
    }
  }
  return issues;
}

function checkSchema(
  manifest: MissionManifest,
  schema: SchemaArtifact,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const req of manifest.requirements.schema_must_contain) {
    const table = schema.tables.find((t) => t.name === req.table);
    if (!table) {
      issues.push({
        category: "schema_missing",
        message: `expected table "${req.table}" not found in schema.json; add a CREATE TABLE migration`,
        context: { requirement: req },
      });
      continue;
    }
    const missingCols = req.required_columns.filter(
      (c) => !table.columns.includes(c),
    );
    if (missingCols.length > 0) {
      issues.push({
        category: "schema_column_missing",
        message: `table "${req.table}" is missing columns: ${missingCols.join(", ")}; found columns: ${table.columns.join(", ")}`,
        context: {
          requirement: req,
          missing: missingCols,
          found: table.columns,
        },
      });
    }
    if (table.rls_classification !== req.rls_classification) {
      issues.push({
        category: "schema_rls_mismatch",
        message: `table "${req.table}" has rls_classification="${table.rls_classification}" but manifest requires "${req.rls_classification}"; review RLS policies on the table`,
        context: { requirement: req, found: table.rls_classification },
      });
    }
  }
  return issues;
}

/**
 * Whether a policy hands `role` any authority.
 *
 * An empty `roles` list is Postgres' `PUBLIC` default — a policy written without
 * a `TO` clause applies to everyone, so treating "no roles listed" as "no roles
 * granted" would read the most permissive policy as the most restrictive one.
 */
function policyGrantsRole(policy: SchemaPolicy, role: string): boolean {
  if (policy.roles.length === 0) return true;
  return policy.roles.some(
    (r) => r === role || r === "public" || r === "PUBLIC",
  );
}

/** Whether a policy's command is covered by a prohibition's command list. */
function policyMatchesCommands(
  policy: SchemaPolicy,
  commands: readonly string[] | undefined,
): boolean {
  if (!commands || commands.length === 0) return true;
  // `FOR ALL` covers every command, so it matches whatever was asked about.
  if (policy.command === "ALL") return true;
  return commands.includes(policy.command);
}

function checkPolicies(
  manifest: MissionManifest,
  schema: SchemaArtifact,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const req of manifest.requirements.policies_must_not_allow ?? []) {
    const table = schema.tables.find((t) => t.name === req.table);
    if (!table) {
      issues.push({
        category: "schema_missing",
        message: `expected table "${req.table}" not found in schema.json; add a CREATE TABLE migration`,
        context: { requirement: req },
      });
      continue;
    }
    const offending = table.policies.filter(
      (p) =>
        policyGrantsRole(p, req.role) && policyMatchesCommands(p, req.commands),
    );
    if (offending.length > 0) {
      const scope = req.commands?.length
        ? req.commands.join(", ")
        : "any command";
      issues.push({
        category: "schema_policy_permits",
        message:
          `table "${req.table}" must not allow role "${req.role}" (${scope}), ` +
          `but ${offending.length} policy/policies do: ` +
          offending
            .map(
              (p) =>
                `"${p.name}" FOR ${p.command} TO ${p.roles.length > 0 ? p.roles.join("/") : "PUBLIC (no TO clause)"}`,
            )
            .join(", ") +
          `; requirement: "${req.description}"`,
        context: { requirement: req, offending },
      });
    }
  }
  return issues;
}

/**
 * An assertion plus the proof it came from. Attribution has to survive the
 * flattening, otherwise a satisfied requirement can't be traced back to the
 * spec that satisfied it.
 */
export interface AttributedAssertion extends TraceAssertion {
  proofId: string;
  specFile?: string;
}

/** Flatten every assertion across every trace / step, keeping attribution. */
export function collectAssertions(bundle: TraceBundle): AttributedAssertion[] {
  const out: AttributedAssertion[] = [];
  for (const trace of bundle) {
    for (const step of trace.steps ?? []) {
      for (const a of step.assertions ?? []) {
        out.push({
          ...a,
          proofId: trace.proofId,
          ...(trace.specFile ? { specFile: trace.specFile } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * Which helper stamps may satisfy a requirement, or `null` for "any stamp".
 *
 * Only `tenant_isolation` is identity-bound: `assert.httpResponse` records
 * whatever `kind` its caller passes, so a mere presence check would let an
 * HTTP probe labelled `tenant_isolation` count as isolation evidence. Table
 * targets accept only `assert.tenantIsolation` (the dual-tenant probe);
 * action targets also accept `assert.authorization`, whose action probes
 * record the cross-tenant invariant they establish.
 */
function allowedHelpersFor(
  kind: string,
  target: string,
  tableNames: ReadonlySet<string>,
): readonly string[] | null {
  if (kind !== "tenant_isolation") return null;
  const head = String(target).split(".")[0];
  return tableNames.has(head)
    ? TENANT_ISOLATION_TABLE_HELPERS
    : TENANT_ISOLATION_ACTION_HELPERS;
}

function checkTraces(
  manifest: MissionManifest,
  bundle: TraceBundle,
  schema: SchemaArtifact,
): { issues: ValidationIssue[]; evidence: RequirementEvidence[] } {
  const issues: ValidationIssue[] = [];
  const evidence: RequirementEvidence[] = [];
  const assertions = collectAssertions(bundle);
  const tableNames = new Set((schema.tables ?? []).map((t) => t.name));

  for (const req of manifest.requirements.trace_must_prove) {
    const requiredRole = normalizeAssertionRole(req.role);
    if (requiredRole === null) {
      issues.push({
        category: "manifest_shape",
        message: `trace_must_prove[].role "${String(req.role)}" is not a valid assertion role; expected "primary" or "control"`,
        context: { requirement: req },
      });
      continue;
    }

    // Candidates share kind + target (and proofId when the requirement pins
    // one). Everything after this is about explaining *why* a candidate does
    // or does not count as evidence.
    const candidates = assertions.filter(
      (a) =>
        a.kind === req.kind &&
        a.target === req.target &&
        (req.proofId === undefined || a.proofId === req.proofId),
    );
    const requiredOrigin = requiredEvidenceOrigin(req.kind, req.evidence);
    const allowedHelpers = allowedHelpersFor(req.kind, req.target, tableNames);
    const originSatisfied = (a: TraceAssertion) =>
      requiredOrigin === "any" ||
      (typeof a.emittedBy === "string" &&
        (allowedHelpers === null || allowedHelpers.includes(a.emittedBy)));
    const match = candidates.find(
      (a) =>
        a.passed === true &&
        normalizeAssertionRole(a.role) === requiredRole &&
        originSatisfied(a),
    );

    if (match) {
      evidence.push({
        kind: req.kind,
        target: req.target,
        role: requiredRole,
        satisfied: true,
        proofId: match.proofId,
        ...(match.specFile ? { specFile: match.specFile } : {}),
        ...(match.detail ? { detail: match.detail } : {}),
        ...(match.emittedBy ? { emittedBy: match.emittedBy } : {}),
      });
      continue;
    }

    evidence.push({
      kind: req.kind,
      target: req.target,
      role: requiredRole,
      satisfied: false,
    });

    // Explain the near miss. "No passing assertion found" sends people hunting
    // for a missing proof when the real cause is usually one of these three.
    const failed = candidates.filter((a) => a.passed === false);
    const wrongRole = candidates.filter(
      (a) =>
        a.passed === true && normalizeAssertionRole(a.role) !== requiredRole,
    );
    const unverified = candidates.filter(
      (a) =>
        a.passed === true &&
        normalizeAssertionRole(a.role) === requiredRole &&
        !originSatisfied(a),
    );

    // A passing right-role assertion exists but its origin disqualifies it —
    // spec-recorded where a helper is demanded, or stamped by a helper that
    // cannot vouch for this kind (assert.httpResponse records the caller's
    // kind verbatim). Its own category: the fix is different and the failure
    // must not read as "no proof was written".
    if (unverified.length > 0) {
      const found = unverified[0].emittedBy
        ? `was emitted by ${unverified[0].emittedBy}, which cannot vouch for this claim`
        : "was recorded directly by spec code (no emittedBy)";
      const wanted = allowedHelpers
        ? allowedHelpers.join(" or ")
        : "an SDK assert.* helper";
      issues.push({
        category: "trace_unverified",
        message:
          `a passing role="${requiredRole}" assertion with kind="${req.kind}" and target="${req.target}" exists but ${found}, ` +
          `and this requirement demands evidence="helper"${req.evidence === undefined ? ` (mandatory for ${req.kind})` : ""}. ` +
          `Emit the claim through ${wanted}` +
          `${allowedHelpers === null ? `, or set evidence: "any" on the requirement if a bespoke probe is intended` : ""}; description: "${req.description}"`,
        context: { requirement: req, unverifiedCount: unverified.length },
      });
      continue;
    }

    let reason: string;
    if (failed.length > 0) {
      reason =
        `found ${failed.length} matching assertion(s) but they FAILED: ` +
        failed
          .map((a) => `[${a.proofId}] ${a.detail ?? "(no detail)"}`)
          .join(" | ");
    } else if (wrongRole.length > 0) {
      reason =
        `found ${wrongRole.length} passing assertion(s) with role="${normalizeAssertionRole(wrongRole[0].role)}" but this requirement needs role="${requiredRole}". ` +
        `A "control" assertion passes by design and only shows the probe could have failed — it cannot stand in for the claim itself. ` +
        `Add the missing ${requiredRole} probe`;
    } else if (req.proofId !== undefined) {
      reason = `no assertion with this kind+target was emitted by proof "${req.proofId}" (other proofs may have emitted one; this requirement is pinned)`;
    } else {
      reason = "no assertion with this kind+target was emitted by any proof";
    }

    issues.push({
      category: "trace_missing",
      message: `no passing role="${requiredRole}" assertion found with kind="${req.kind}" and target="${req.target}"; ${reason}; description: "${req.description}"`,
      context: { requirement: req, candidateCount: candidates.length },
    });
  }

  return { issues, evidence };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ValidateMissionInput {
  manifest: unknown;
  capabilities: CapabilitiesArtifact;
  schema: SchemaArtifact;
  traces: TraceBundle;
}

export function validateMission(input: ValidateMissionInput): ValidationResult {
  const shape = shapeIssues(input.manifest);
  if (shape.length > 0) {
    return {
      missionId:
        (input.manifest as { missionId?: string } | null)?.missionId ??
        "<invalid>",
      ok: false,
      issues: shape,
    };
  }

  const manifest = input.manifest as MissionManifest;
  const traceResult = checkTraces(manifest, input.traces, input.schema);
  const issues: ValidationIssue[] = [
    ...checkCapabilities(manifest, input.capabilities),
    ...checkSchema(manifest, input.schema),
    ...checkPolicies(manifest, input.schema),
    ...traceResult.issues,
  ];

  return {
    missionId: manifest.missionId,
    ok: issues.length === 0,
    issues,
    evidence: traceResult.evidence,
  };
}
