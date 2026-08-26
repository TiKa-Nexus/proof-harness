// Import External Packages
import { describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import { validateMission } from "../node/validate-mission";
import type {
  CapabilitiesArtifact,
  SchemaArtifact,
} from "../node/validate-mission";
import type { MissionManifest } from "../shared/mission-types";
import type { TraceArtifact, TraceAssertion } from "../shared/trace-types";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_CAPABILITIES: CapabilitiesArtifact = {
  schemaVersion: 1,
  capabilities: [],
};

const EMPTY_SCHEMA: SchemaArtifact = { schemaVersion: 1, tables: [] };

function manifest(
  traceRequirements: MissionManifest["requirements"]["trace_must_prove"],
): MissionManifest {
  return {
    schemaVersion: 1,
    missionId: "M-TEST",
    missionTitle: "Test mission",
    createdAt: "2026-07-01T00:00:00.000Z",
    requirements: {
      capabilities_must_exist: [],
      schema_must_contain: [],
      trace_must_prove: traceRequirements,
    },
  };
}

function traceWith(
  proofId: string,
  assertions: TraceAssertion[],
  overrides: Partial<TraceArtifact> = {},
): TraceArtifact {
  return {
    schemaVersion: 2,
    proofId,
    specFile: `e2e/proofs/${proofId}.proof.ts`,
    specHash: "abc123def456",
    timestamp: "2026-07-01T00:00:00.000Z",
    durationMs: 10,
    passed: assertions.every((a) => a.passed),
    steps: [
      {
        intent: "probe",
        kind: assertions[0]?.kind ?? "happy_path",
        target: assertions[0]?.target ?? "x",
        observation: "",
        passed: assertions.every((a) => a.passed),
        durationMs: 10,
        assertions,
      },
    ],
    ...overrides,
  };
}

/** Run a case through the implementation shared by the SDK and CLI. */
function validateBoth(input: {
  manifest: unknown;
  capabilities?: CapabilitiesArtifact;
  schema?: SchemaArtifact;
  traces?: readonly TraceArtifact[];
}) {
  const args = {
    manifest: input.manifest,
    capabilities: input.capabilities ?? EMPTY_CAPABILITIES,
    schema: input.schema ?? EMPTY_SCHEMA,
    traces: input.traces ?? [],
  };
  return validateMission(args);
}

// ---------------------------------------------------------------------------
// The regression that matters most: controls must not satisfy requirements
// ---------------------------------------------------------------------------

describe("validateMission — assertion roles", () => {
  const requirement = [
    {
      kind: "tenant_isolation" as const,
      target: "workspace_members",
      description: "outsider cannot read another workspace's members",
    },
  ];

  it("does NOT accept a passing control as evidence for a primary requirement", () => {
    // A control passes by design. If it could satisfy a requirement, then
    // assert.tenantIsolation's own "the owner CAN read their rows" assertion
    // would be enough to mark a mission green without ever proving isolation.
    const result = validateBoth({
      manifest: manifest(requirement),
      traces: [
        traceWith("iso", [
          {
            kind: "tenant_isolation",
            target: "workspace_members",
            passed: true,
            role: "control",
            detail: "owner read 1 row",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("trace_missing");
    expect(result.issues[0].message).toContain('role="control"');
    expect(result.issues[0].message).toContain("cannot stand in for the claim");
  });

  it("accepts a passing primary assertion", () => {
    const result = validateBoth({
      manifest: manifest(requirement),
      traces: [
        traceWith("iso", [
          {
            kind: "tenant_isolation",
            target: "workspace_members",
            passed: true,
            role: "primary",
            detail: "user B saw 0 of 1 rows",
            emittedBy: "assert.tenantIsolation",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("treats a missing role as primary", () => {
    const result = validateBoth({
      manifest: manifest(requirement),
      traces: [
        traceWith("iso", [
          {
            kind: "tenant_isolation",
            target: "workspace_members",
            passed: true,
            emittedBy: "assert.tenantIsolation",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts the deprecated negative / positive_control spellings", () => {
    // A manifest written against the earlier naming must keep working.
    const negativeRequirement = [
      { ...requirement[0], role: "negative" as never },
    ];

    const satisfied = validateBoth({
      manifest: manifest(negativeRequirement),
      traces: [
        traceWith("iso", [
          {
            kind: "tenant_isolation",
            target: "workspace_members",
            passed: true,
            role: "positive_control" as never,
          },
        ]),
      ],
    });
    // role=negative normalizes to primary; the only assertion is a control.
    expect(satisfied.ok).toBe(false);
    expect(satisfied.issues[0].message).toContain('role="control"');

    const proved = validateBoth({
      manifest: manifest(negativeRequirement),
      traces: [
        traceWith("iso", [
          {
            kind: "tenant_isolation",
            target: "workspace_members",
            passed: true,
            role: "negative" as never,
            emittedBy: "assert.tenantIsolation",
          },
        ]),
      ],
    });
    expect(proved.ok).toBe(true);
  });

  it("rejects an unrecognised role instead of silently ignoring it", () => {
    const result = validateBoth({
      manifest: manifest([{ ...requirement[0], role: "sortof" as never }]),
      traces: [],
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].category).toBe("manifest_shape");
    expect(result.issues[0].message).toContain("is not a valid assertion role");
  });
});

// ---------------------------------------------------------------------------
// Evidence origin: who recorded the assertion matters
// ---------------------------------------------------------------------------

describe("validateMission — evidence origin", () => {
  const isolationRequirement = {
    kind: "tenant_isolation" as const,
    target: "widgets",
    description: "outsider cannot read another workspace's widgets",
  };

  it("rejects a spec-recorded tenant_isolation primary by default (trace_unverified)", () => {
    // A hand-rolled recordAssertion carries none of assert.tenantIsolation's
    // vacuity controls; without this rule it would be the cheapest way to
    // manufacture green isolation evidence.
    const result = validateBoth({
      manifest: manifest([isolationRequirement]),
      traces: [
        traceWith("widgets-iso", [
          {
            kind: "tenant_isolation",
            target: "widgets",
            passed: true,
            role: "primary",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("trace_unverified");
    expect(result.issues[0].message).toContain(
      "recorded directly by spec code",
    );
    expect(result.evidence?.[0].satisfied).toBe(false);
  });

  it('rejects evidence: "any" for tenant_isolation as manifest_shape', () => {
    // Strict coverage refuses raw isolation assertions unconditionally, so
    // the mission gate offering an opt-out would make the two gates disagree
    // about the same evidence. There is no opt-out; bespoke escapes belong in
    // mutation policy.
    const result = validateBoth({
      manifest: manifest([{ ...isolationRequirement, evidence: "any" }]),
      traces: [],
    });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) =>
          i.category === "manifest_shape" &&
          i.message.includes(
            '"any" is not allowed for kind "tenant_isolation"',
          ),
      ),
    ).toBe(true);
  });

  it("binds helper identity: a caller-kind helper cannot vouch for table isolation", () => {
    // assert.httpResponse records whatever kind its caller passes, so its
    // stamp on a tenant_isolation assertion proves only that an HTTP probe
    // ran. For a table target, only assert.tenantIsolation counts.
    const widgetsSchema: SchemaArtifact = {
      schemaVersion: 1,
      tables: [
        {
          name: "widgets",
          columns: ["id", "workspace_id"],
          rls_classification: "workspace_scoped",
          policies: [],
          sourceFiles: [],
        },
      ],
    };
    const traceFor = (emittedBy: string) => [
      traceWith("widgets-iso", [
        {
          kind: "tenant_isolation" as const,
          target: "widgets",
          passed: true,
          role: "primary" as const,
          emittedBy,
        },
      ]),
    ];

    const httpStamp = validateBoth({
      manifest: manifest([isolationRequirement]),
      schema: widgetsSchema,
      traces: traceFor("assert.httpResponse"),
    });
    expect(httpStamp.ok).toBe(false);
    expect(httpStamp.issues[0].category).toBe("trace_unverified");
    expect(httpStamp.issues[0].message).toContain(
      "cannot vouch for this claim",
    );

    // assert.authorization vouches for action-target isolation, not tables.
    const authStampOnTable = validateBoth({
      manifest: manifest([isolationRequirement]),
      schema: widgetsSchema,
      traces: traceFor("assert.authorization"),
    });
    expect(authStampOnTable.ok).toBe(false);
    expect(authStampOnTable.issues[0].category).toBe("trace_unverified");

    const realStamp = validateBoth({
      manifest: manifest([isolationRequirement]),
      schema: widgetsSchema,
      traces: traceFor("assert.tenantIsolation"),
    });
    expect(realStamp.ok).toBe(true);
  });

  it("accepts assert.authorization for tenant_isolation on an action target", () => {
    const result = validateBoth({
      manifest: manifest([
        {
          kind: "tenant_isolation" as const,
          target: "widgets:updateWidget",
          description: "cross-tenant call is refused at the action layer",
        },
      ]),
      traces: [
        traceWith("action-iso", [
          {
            kind: "tenant_isolation",
            target: "widgets:updateWidget",
            passed: true,
            role: "primary",
            emittedBy: "assert.authorization",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(true);
  });

  it('lets a mission demand helper origin for other kinds via evidence: "helper"', () => {
    const authRequirement = {
      kind: "authorization" as const,
      target: "deduct_workspace_credits",
      description: "authenticated caller cannot execute the RPC",
      evidence: "helper" as const,
    };
    const rawTrace = traceWith("rpc-guard", [
      {
        kind: "authorization",
        target: "deduct_workspace_credits",
        passed: true,
        role: "primary",
      },
    ]);

    const demanded = validateBoth({
      manifest: manifest([authRequirement]),
      traces: [rawTrace],
    });
    expect(demanded.ok).toBe(false);
    expect(demanded.issues[0].category).toBe("trace_unverified");

    // The same raw assertion satisfies the kind's default ("any").
    const defaulted = validateBoth({
      manifest: manifest([{ ...authRequirement, evidence: undefined }]),
      traces: [rawTrace],
    });
    expect(defaulted.ok).toBe(true);
  });

  it("records the satisfying assertion's emittedBy in evidence", () => {
    const result = validateBoth({
      manifest: manifest([isolationRequirement]),
      traces: [
        traceWith("widgets-iso", [
          {
            kind: "tenant_isolation",
            target: "widgets",
            passed: true,
            role: "primary",
            emittedBy: "assert.tenantIsolation",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.evidence?.[0].emittedBy).toBe("assert.tenantIsolation");
  });

  it("rejects an unknown evidence value as manifest_shape", () => {
    const result = validateBoth({
      manifest: manifest([
        { ...isolationRequirement, evidence: "vibes" as never },
      ]),
      traces: [],
    });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) =>
          i.category === "manifest_shape" &&
          i.message.includes("is not a valid evidence origin"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// expectedChanges: the drift bound is shape-checked here, enforced by
// scripts/proof_drift.mjs
// ---------------------------------------------------------------------------

describe("validateMission — expectedChanges shape", () => {
  it("accepts a well-formed budget and treats absence as valid", () => {
    const withBlock = validateBoth({
      manifest: {
        ...manifest([]),
        expectedChanges: {
          modules: ["issues"],
          actions: [
            "issues:createIssue",
            { ref: "workspace:removeMember", changes: ["middleware_changed"] },
          ],
          tables: [
            "issues",
            { name: "workspaces", changes: ["columns_added"] },
          ],
          dependencies: ["@foo/bar"],
          lockfile: true,
        },
      },
    });
    expect(withBlock.ok).toBe(true);

    const without = validateBoth({ manifest: manifest([]) });
    expect(without.ok).toBe(true);
  });

  it("fails a malformed block as manifest_shape instead of half-enforcing it", () => {
    const wrongType = validateBoth({
      manifest: { ...manifest([]), expectedChanges: "issues" },
    });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.issues[0].message).toBe(
      "expectedChanges must be an object when present",
    );

    const wrongList = validateBoth({
      manifest: {
        ...manifest([]),
        expectedChanges: { modules: ["issues", 42] },
      },
    });
    expect(wrongList.ok).toBe(false);
    expect(wrongList.issues[0].message).toContain(
      "expectedChanges.modules must be an array of non-empty strings",
    );
  });

  it("rejects entry objects with missing names or unknown change kinds", () => {
    const missingRef = validateBoth({
      manifest: {
        ...manifest([]),
        expectedChanges: { actions: [{ changes: ["added"] }] },
      },
    });
    expect(missingRef.ok).toBe(false);
    expect(missingRef.issues[0].message).toContain(
      "expectedChanges.actions[].ref is required",
    );

    const unknownKind = validateBoth({
      manifest: {
        ...manifest([]),
        expectedChanges: { tables: [{ name: "issues", changes: ["renamed"] }] },
      },
    });
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.issues[0].message).toContain(
      "expectedChanges.tables[].changes must be a non-empty array drawn from",
    );

    const badLockfile = validateBoth({
      manifest: { ...manifest([]), expectedChanges: { lockfile: "yes" } },
    });
    expect(badLockfile.ok).toBe(false);
    expect(badLockfile.issues[0].message).toContain(
      "expectedChanges.lockfile must be a boolean",
    );
  });
});

// ---------------------------------------------------------------------------
// Attribution: which proof actually made the claim
// ---------------------------------------------------------------------------

describe("validateMission — evidence attribution", () => {
  const requirement = {
    kind: "authorization" as const,
    target: "workspace:removeMember",
    description: "member cannot remove an admin",
  };

  it("records which proof and spec file supplied the evidence", () => {
    const result = validateBoth({
      manifest: manifest([requirement]),
      traces: [
        traceWith("member-remove", [
          {
            kind: "authorization",
            target: "workspace:removeMember",
            passed: true,
            role: "primary",
            detail: "action rejected member",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.evidence).toEqual([
      {
        kind: "authorization",
        target: "workspace:removeMember",
        role: "primary",
        satisfied: true,
        proofId: "member-remove",
        specFile: "e2e/proofs/member-remove.proof.ts",
        detail: "action rejected member",
      },
    ]);
  });

  it("reports unsatisfied requirements in evidence too", () => {
    const result = validateBoth({
      manifest: manifest([requirement]),
      traces: [],
    });

    expect(result.evidence).toEqual([
      {
        kind: "authorization",
        target: "workspace:removeMember",
        role: "primary",
        satisfied: false,
      },
    ]);
  });

  it("honours proofId pinning so an unrelated spec cannot satisfy a requirement", () => {
    // Without pinning, any proof in the run may satisfy any requirement. That is
    // the documented default, but a mission that cares must be able to say so.
    const traces = [
      traceWith("some-other-proof", [
        {
          kind: "authorization",
          target: "workspace:removeMember",
          passed: true,
          role: "primary",
        },
      ]),
    ];

    const unpinned = validateBoth({
      manifest: manifest([requirement]),
      traces,
    });
    expect(unpinned.ok).toBe(true);
    expect(unpinned.evidence?.[0].proofId).toBe("some-other-proof");

    const pinned = validateBoth({
      manifest: manifest([{ ...requirement, proofId: "the-real-proof" }]),
      traces,
    });
    expect(pinned.ok).toBe(false);
    expect(pinned.issues[0].message).toContain("this requirement is pinned");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics: the message has to name the actual cause
// ---------------------------------------------------------------------------

describe("validateMission — failure diagnostics", () => {
  const requirement = {
    kind: "tenant_isolation" as const,
    target: "notes",
    description: "notes are workspace scoped",
  };

  it("distinguishes a failing assertion from a missing one", () => {
    const result = validateBoth({
      manifest: manifest([requirement]),
      traces: [
        traceWith("notes-iso", [
          {
            kind: "tenant_isolation",
            target: "notes",
            passed: false,
            role: "primary",
            detail: "user B saw 3 rows",
          },
        ]),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("but they FAILED");
    expect(result.issues[0].message).toContain("user B saw 3 rows");
  });

  it("says so plainly when nothing matched at all", () => {
    const result = validateBoth({
      manifest: manifest([requirement]),
      traces: [
        traceWith("unrelated", [
          { kind: "happy_path", target: "auth.signin", passed: true },
        ]),
      ],
    });

    expect(result.issues[0].message).toContain(
      "no assertion with this kind+target was emitted by any proof",
    );
  });
});

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe("validateMission — manifest shape", () => {
  it("fails fast on shape errors without attempting cross-reference", () => {
    const result = validateBoth({
      manifest: { schemaVersion: 99, missionId: "M-X" },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.every((i) => i.category === "manifest_shape")).toBe(
      true,
    );
    expect(result.issues.map((i) => i.message)).toContain(
      "expected schemaVersion=1, found 99",
    );
  });

  it("requires missionTitle and createdAt", () => {
    const result = validateBoth({
      manifest: {
        schemaVersion: 1,
        missionId: "M-X",
        requirements: {
          capabilities_must_exist: [],
          schema_must_contain: [],
          trace_must_prove: [],
        },
      },
    });

    const messages = result.issues.map((i) => i.message);
    expect(messages).toContain("missionTitle is required (non-empty string)");
    expect(messages).toContain("createdAt is required (ISO-8601 string)");
  });

  it("rejects a non-object manifest", () => {
    const result = validateBoth({ manifest: null });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toBe("manifest is not a JSON object");
  });
});

// ---------------------------------------------------------------------------
// Cross-reference against capabilities / schema
// ---------------------------------------------------------------------------

describe("validateMission — capability and schema cross-reference", () => {
  it("reports a missing capability, a verb mismatch and missing invariants", () => {
    const base: MissionManifest = {
      ...manifest([]),
      requirements: {
        capabilities_must_exist: [
          {
            name: "createNote",
            module: "notes",
            verb: "create",
            object: "note",
            invariants: ["tenant_isolation"],
          },
        ],
        schema_must_contain: [],
        trace_must_prove: [],
      },
    };

    const missing = validateBoth({ manifest: base });
    expect(missing.issues[0].category).toBe("capability_missing");

    const mismatched = validateBoth({
      manifest: base,
      capabilities: {
        schemaVersion: 1,
        capabilities: [
          {
            name: "createNote",
            module: "notes",
            verb: "update",
            object: "note",
            invariants: [],
            file: "x.ts",
          },
        ],
      },
    });
    const categories = mismatched.issues.map((i) => i.category);
    expect(categories).toContain("capability_mismatch");
    expect(
      mismatched.issues.some((i) => i.message.includes("missing invariants")),
    ).toBe(true);
  });

  it("reports missing tables, missing columns and RLS classification drift", () => {
    const base: MissionManifest = {
      ...manifest([]),
      requirements: {
        capabilities_must_exist: [],
        schema_must_contain: [
          {
            table: "notes",
            required_columns: ["id", "workspace_id"],
            rls_classification: "workspace_scoped",
          },
        ],
        trace_must_prove: [],
      },
    };

    const missing = validateBoth({ manifest: base });
    expect(missing.issues[0].category).toBe("schema_missing");

    const drifted = validateBoth({
      manifest: base,
      schema: {
        schemaVersion: 1,
        tables: [
          {
            name: "notes",
            columns: ["id"],
            rls_classification: "public_read",
            policies: [],
            sourceFiles: [],
          },
        ],
      },
    });
    const categories = drifted.issues.map((i) => i.category);
    expect(categories).toContain("schema_column_missing");
    expect(categories).toContain("schema_rls_mismatch");
  });
});

// ---------------------------------------------------------------------------
// policies_must_not_allow — the per-command claims one classification cannot make
// ---------------------------------------------------------------------------

describe("validateMission — policies_must_not_allow", () => {
  function prohibitionManifest(
    policies_must_not_allow: NonNullable<
      MissionManifest["requirements"]["policies_must_not_allow"]
    >,
  ): MissionManifest {
    return {
      ...manifest([]),
      requirements: {
        capabilities_must_exist: [],
        schema_must_contain: [],
        trace_must_prove: [],
        policies_must_not_allow,
      },
    };
  }

  function schemaWithPolicies(
    policies: Array<{ name: string; command: string; roles: string[] }>,
  ): SchemaArtifact {
    return {
      schemaVersion: 1,
      tables: [
        {
          name: "audit_logs",
          columns: ["id"],
          rls_classification: "admin_only",
          policies,
          sourceFiles: ["supabase/migrations/initial.sql"],
        },
      ],
    };
  }

  // Phrased as reachability, which is what the check measures: it does not read
  // USING clauses, so "only admins can read" is a claim for a proof, not a
  // manifest.
  const noReadsForMembers = [
    {
      table: "audit_logs",
      role: "authenticated",
      commands: ["SELECT"] as const,
      description: "no policy targets members for audit log reads",
    },
  ];

  it("fails when a policy grants the prohibited role", () => {
    const result = validateBoth({
      manifest: prohibitionManifest(noReadsForMembers),
      schema: schemaWithPolicies([
        {
          name: "audit_logs_member_read",
          command: "SELECT",
          roles: ["authenticated"],
        },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].category).toBe("schema_policy_permits");
    // The failure has to name the policy: "something grants this" sends the
    // reader through every migration touching the table.
    expect(result.issues[0].message).toContain("audit_logs_member_read");
  });

  it("passes when only the service role is granted", () => {
    const result = validateBoth({
      manifest: prohibitionManifest(noReadsForMembers),
      schema: schemaWithPolicies([
        {
          name: "audit_logs_service_write",
          command: "INSERT",
          roles: ["service_role"],
        },
      ]),
    });
    expect(result.ok).toBe(true);
  });

  it("treats a policy with no TO clause as granting everyone", () => {
    // Postgres defaults an omitted TO clause to PUBLIC. Reading "no roles
    // listed" as "no roles granted" would let the most permissive policy in the
    // file look like the most restrictive one.
    const result = validateBoth({
      manifest: prohibitionManifest(noReadsForMembers),
      schema: schemaWithPolicies([
        { name: "audit_logs_open_read", command: "SELECT", roles: [] },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain("PUBLIC (no TO clause)");
  });

  it("counts FOR ALL against a single-command prohibition", () => {
    const result = validateBoth({
      manifest: prohibitionManifest(noReadsForMembers),
      schema: schemaWithPolicies([
        {
          name: "audit_logs_all",
          command: "ALL",
          roles: ["authenticated"],
        },
      ]),
    });
    expect(result.ok).toBe(false);
  });

  it("does not fire on a command the prohibition did not name", () => {
    const result = validateBoth({
      manifest: prohibitionManifest(noReadsForMembers),
      schema: schemaWithPolicies([
        {
          name: "audit_logs_member_insert",
          command: "INSERT",
          roles: ["authenticated"],
        },
      ]),
    });
    expect(result.ok).toBe(true);
  });

  it("covers every command when `commands` is omitted", () => {
    const result = validateBoth({
      manifest: prohibitionManifest([
        {
          table: "audit_logs",
          role: "authenticated",
          description: "members cannot touch the audit log at all",
        },
      ]),
      schema: schemaWithPolicies([
        {
          name: "audit_logs_member_insert",
          command: "INSERT",
          roles: ["authenticated"],
        },
      ]),
    });
    expect(result.ok).toBe(false);
  });

  it("reports a missing table rather than passing vacuously", () => {
    // A prohibition about a table that does not exist is satisfied by accident,
    // and accidents are exactly what this is for.
    const result = validateBoth({
      manifest: prohibitionManifest(noReadsForMembers),
    });
    expect(result.issues[0].category).toBe("schema_missing");
  });

  it("rejects a mistyped command instead of matching nothing", () => {
    const result = validateBoth({
      manifest: prohibitionManifest([
        {
          table: "audit_logs",
          role: "authenticated",
          commands: ["READ"] as never,
          description: "typo in the command",
        },
      ]),
      schema: schemaWithPolicies([
        {
          name: "audit_logs_member_read",
          command: "SELECT",
          roles: ["authenticated"],
        },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].category).toBe("manifest_shape");
    expect(result.issues[0].message).toContain("POLICY_COMMANDS");
  });

  it("rejects a prohibition with no role", () => {
    const result = validateBoth({
      manifest: prohibitionManifest([
        {
          table: "audit_logs",
          role: "",
          description: "missing role",
        },
      ]),
    });
    expect(result.issues[0].category).toBe("manifest_shape");
  });

  it("stays valid when the block is absent", () => {
    const result = validateBoth({ manifest: manifest([]) });
    expect(result.ok).toBe(true);
  });
});
