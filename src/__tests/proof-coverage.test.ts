// Import External Packages
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// The package coverage engine is the ratchet: it fails CI when a scoped
// table gains no proof. A ratchet that has quietly stopped catching things is
// worse than no ratchet, because the green build is read as coverage.
//
// The script is a CLI that reads `.proof/*` relative to the working directory,
// so it is exercised here the way it actually runs — as a subprocess against a
// throwaway fixture directory. No refactor for testability, and no chance of
// testing a different code path than CI uses.
// ---------------------------------------------------------------------------

const SCRIPT = path.resolve(
  import.meta.dirname,
  "../../cli/engines/proof_coverage.mjs",
);

let dir: string;

function write(relative: string, value: unknown) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

/** A table plus a passing primary assertion for it, i.e. the proven baseline. */
function fixture({
  classification = "workspace_scoped",
  assertions = [
    {
      kind: "tenant_isolation",
      target: "widgets",
      passed: true,
      role: "primary",
      emittedBy: "assert.tenantIsolation",
    },
  ],
  policy = { schemaVersion: 1, acceptedGaps: [], reviewedUnclassified: [] },
  capabilities = [],
}: {
  classification?: string;
  assertions?: unknown[];
  policy?: unknown;
  capabilities?: unknown[];
} = {}) {
  write(".proof/schema.json", {
    schemaVersion: 1,
    tables: [
      {
        name: "widgets",
        columns: ["id", "workspace_id"],
        rls_classification: classification,
        policies: [],
        files: [],
      },
    ],
  });
  write(".proof/capabilities.json", { schemaVersion: 1, capabilities });
  write(".proof/traces/widgets.json", {
    schemaVersion: 2,
    proofId: "widgets",
    timestamp: "2026-08-15T00:00:00.000Z",
    durationMs: 1,
    passed: true,
    steps: [
      {
        intent: "probe",
        kind: "tenant_isolation",
        target: "widgets",
        observation: "",
        passed: true,
        durationMs: 1,
        assertions,
      },
    ],
  });
  write(".proof/coverage-policy.json", policy);
}

function runStrict() {
  const res = spawnSync("node", [SCRIPT, "--strict"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = `${res.stdout}${res.stderr}`;
  // `flat` collapses whitespace, because the report word-wraps prose to keep the
  // CLI readable and an assertion on a phrase should not depend on where a line
  // happens to break.
  return { code: res.status, output, flat: output.replace(/\s+/g, " ") };
}

function run(...args: string[]) {
  const res = spawnSync("node", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = `${res.stdout}${res.stderr}`;
  return { code: res.status, output, flat: output.replace(/\s+/g, " ") };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-coverage-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("proof:coverage --strict", () => {
  it("passes when every derived requirement has a passing primary assertion", () => {
    fixture();
    const { code, output, flat } = runStrict();
    expect(code, output).toBe(0);
    expect(flat).toContain("proven");
  });

  it("fails when a scoped table has no proof at all", () => {
    fixture({ assertions: [] });
    const { code, output } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_gap");
    expect(output).toContain("widgets");
  });

  it("does not accept a control assertion as evidence for the claim", () => {
    // The regression this guards: controls pass by design, so counting them
    // would mark a table proven on the strength of its fixture working.
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "control",
        },
      ],
    });
    expect(runStrict().code).toBe(1);
  });

  it("does not accept a caller-kind helper's stamp as table-isolation evidence", () => {
    // assert.httpResponse records whatever kind its caller passes, so its
    // stamp on a tenant_isolation assertion proves an HTTP probe ran, not
    // that anything checked cross-tenant visibility. Identity, not mere
    // presence, is what counts.
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.httpResponse",
        },
      ],
    });
    const { code, output, flat } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_gap");
    expect(flat).toContain("UNVERIFIED ORIGIN");
    expect(flat).toContain("assert.httpResponse");
  });

  it("does not accept a spec-recorded tenant_isolation primary (no emittedBy)", () => {
    // Helper provenance is what says the assertion went through
    // assert.tenantIsolation's vacuity controls. A raw recordAssertion with
    // the right kind+target must leave the table showing as a gap — and be
    // listed, so the gap is explicable rather than mysterious.
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
        },
      ],
    });
    const { code, output, flat } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_gap");
    expect(flat).toContain("UNVERIFIED ORIGIN");
    expect(flat).toContain("recorded directly by spec code");
  });

  it("does not accept a skipped assertion as evidence for the claim", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: false,
          status: "skipped",
          role: "primary",
        },
      ],
    });
    expect(runStrict().code).toBe(1);
  });

  it("does not accept the wrong kind of proof for the requirement", () => {
    fixture({
      assertions: [
        {
          kind: "happy_path",
          target: "widgets",
          passed: true,
          role: "primary",
        },
      ],
    });
    expect(runStrict().code).toBe(1);
  });

  it("passes a gap that is declared in the policy, with the reason echoed", () => {
    fixture({
      assertions: [],
      policy: {
        schemaVersion: 1,
        acceptedGaps: [
          {
            table: "widgets",
            kind: "tenant_isolation",
            reason: "fixture needs a paid Stripe account",
          },
        ],
        reviewedUnclassified: [],
      },
    });
    const { code, output, flat } = runStrict();
    expect(code, output).toBe(0);
    expect(flat).toContain("fixture needs a paid Stripe account");
  });

  it("fails on an acceptance that is no longer needed", () => {
    // Otherwise a stale entry keeps licensing a regression it was never about.
    fixture({
      policy: {
        schemaVersion: 1,
        acceptedGaps: [
          { table: "widgets", kind: "tenant_isolation", reason: "stale" },
        ],
        reviewedUnclassified: [],
      },
    });
    const { code, output } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_policy_stale");
  });

  it("fails on a table whose policies the parser could not classify", () => {
    // No requirement can be derived for these, so without this check an
    // unparseable policy would be the cheapest way off the report.
    fixture({ classification: "unclassified" });
    const { code, output } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_blind_spot");
  });

  it("passes an unclassified table once it has been reviewed", () => {
    fixture({
      classification: "unclassified",
      policy: {
        schemaVersion: 1,
        acceptedGaps: [],
        reviewedUnclassified: [
          { table: "widgets", note: "admin-gated via is_super_admin subquery" },
        ],
      },
    });
    const { code, output, flat } = runStrict();
    expect(code, output).toBe(0);
    expect(flat).toContain("admin-gated");
  });

  it("requires nothing of a public_read table", () => {
    fixture({ classification: "public_read", assertions: [] });
    expect(runStrict().code).toBe(0);
  });

  it("requires nothing of an action that declares no invariant", () => {
    fixture({
      capabilities: [
        { name: "renameWidget", module: "widgets", verb: "update" },
      ],
    });
    expect(runStrict().code).toBe(0);
  });

  it("fails when an action declares an invariant no assertion targets", () => {
    // withProof is voluntary, so the only thing that keeps a declaration from
    // being decoration is having to pay for it with evidence.
    fixture({
      capabilities: [
        {
          name: "removeWidget",
          module: "widgets",
          verb: "delete",
          invariants: ["authorization"],
        },
      ],
    });
    const { code, output } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_gap");
    expect(output).toContain("widgets:removeWidget");
  });

  it("passes when the declared invariant is asserted against the action ref", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "authorization",
          target: "widgets:removeWidget",
          passed: true,
          role: "primary",
        },
      ],
      capabilities: [
        {
          name: "removeWidget",
          module: "widgets",
          verb: "delete",
          invariants: ["authorization"],
        },
      ],
    });
    const { code, output, flat } = runStrict();
    expect(code, output).toBe(0);
    expect(flat).toMatch(/widgets:removeWidget +authorization +proven/);
  });

  it("derives a mandatory boundary for workspace-id-driven service-role mutations", () => {
    fixture({
      capabilities: [
        {
          name: "updateWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, output, flat } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("service_role_action_gap");
    expect(flat).toContain("widgets:updateWidget (denial + allowed control)");
  });

  it("allows existing service-action debt only through an explicit policy entry", () => {
    fixture({
      policy: {
        schemaVersion: 1,
        acceptedGaps: [],
        acceptedActionGaps: [
          {
            action: "widgets:updateWidget",
            reason: "Legacy action awaiting an allowed-path fixture",
          },
        ],
        reviewedUnclassified: [],
      },
      capabilities: [
        {
          name: "updateWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, output, flat } = runStrict();
    expect(code, output).toBe(0);
    expect(flat).toContain("Legacy action awaiting an allowed-path fixture");
  });

  it("fails when an accepted service-action gap becomes fully proven", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "authorization",
          target: "widgets:updateWidget",
          passed: true,
          role: "primary",
        },
        {
          kind: "happy_path",
          target: "widgets:updateWidget",
          passed: true,
          role: "control",
        },
      ],
      policy: {
        schemaVersion: 1,
        acceptedGaps: [],
        acceptedActionGaps: [
          {
            action: "widgets:updateWidget",
            reason: "This should now be removed",
          },
        ],
        reviewedUnclassified: [],
      },
      capabilities: [
        {
          name: "updateWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, output } = runStrict();
    expect(code).toBe(1);
    expect(output).toContain("coverage_policy_stale");
    expect(output).toContain("widgets:updateWidget");
  });

  it("requires an allowed-path control in addition to the action denial", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "tenant_isolation",
          target: "widgets:updateWidget",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
      ],
      capabilities: [
        {
          name: "updateWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, flat } = runStrict();
    expect(code).toBe(1);
    expect(flat).toContain("widgets:updateWidget (allowed control)");
  });

  it("requires a denial even when the allowed action path works", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "happy_path",
          target: "widgets:updateWidget",
          passed: true,
          role: "control",
        },
      ],
      capabilities: [
        {
          name: "updateWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, flat } = runStrict();
    expect(code).toBe(1);
    expect(flat).toContain("widgets:updateWidget (denial)");
  });

  it("passes the derived boundary without any withProof declaration", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "tenant_isolation",
          target: "widgets:updateWidget",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "happy_path",
          target: "widgets:updateWidget",
          passed: true,
          role: "control",
        },
      ],
      capabilities: [
        {
          name: "updateWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, output, flat } = runStrict();
    expect(code, output).toBe(0);
    expect(flat).toMatch(
      /widgets:updateWidget +widgets +proven +proven +proven/,
    );
  });

  it("does not derive boundaries for reads, webhook plumbing, or user-scoped writes", () => {
    fixture({
      classification: "user_scoped",
      capabilities: [
        {
          name: "getWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          serviceRoleMutations: [],
        },
        {
          name: "storeWidgetWebhook",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: true,
          internalOnly: true,
          serviceRoleMutations: [{ table: "widgets", operation: "insert" }],
        },
        {
          name: "updateOwnWidget",
          module: "widgets",
          invariants: [],
          acceptsWorkspaceId: false,
          serviceRoleMutations: [{ table: "widgets", operation: "update" }],
        },
      ],
    });

    const { code, output } = runStrict();
    expect(code, output).toBe(0);
    expect(output).not.toContain("SERVICE-ROLE ACTION BOUNDARIES");
  });

  it("ends on a PASS verdict when there is nothing to fix", () => {
    fixture();
    const { flat } = runStrict();
    expect(flat).toContain("[proof:coverage] PASS");
  });

  it("does not emit [PROOF_FAIL] lines without --strict", () => {
    // The consumer treats any [PROOF_FAIL] line as a failed run, so a report
    // that is only being read must not look like a verdict.
    fixture({ assertions: [] });
    const { code, output, flat } = run();
    expect(code).toBe(0);
    expect(output).not.toContain("[PROOF_FAIL]");
    expect(flat).toContain("re-run with --strict");
  });

  it("still exits 1 under --strict --json, where there is no report to read", () => {
    fixture({ assertions: [] });
    const { code, output } = run("--strict", "--json");
    expect(code).toBe(1);
    expect(JSON.parse(output).rows[0].status).toBe("gap");
  });

  it("does not accept a control assertion as evidence for a declared claim", () => {
    fixture({
      assertions: [
        {
          kind: "tenant_isolation",
          target: "widgets",
          passed: true,
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "authorization",
          target: "widgets:removeWidget",
          passed: true,
          role: "control",
        },
      ],
      capabilities: [
        {
          name: "removeWidget",
          module: "widgets",
          verb: "delete",
          invariants: ["authorization"],
        },
      ],
    });
    expect(runStrict().code).toBe(1);
  });
});
