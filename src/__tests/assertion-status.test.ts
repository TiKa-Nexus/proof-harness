// Import External Packages
import { describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import { validateMission } from "../node/validate-mission";
import type { MissionManifest } from "../shared/mission-types";
import {
  normalizeAssertionStatus,
  type TraceArtifact,
  type TraceAssertion,
} from "../shared/trace-types";
// Import Extension Dependencies

import { countAssertionStatuses } from "../../cli/engines/proof_verify.mjs";

// ---------------------------------------------------------------------------
// The point of a status axis
//
// `passed` is a boolean, and "we did not find out" has to round to one side of
// it. Rounding to true is how a suite quietly stops proving things; rounding to
// false makes a skip indistinguishable from a real failure. The status field
// carries the distinction, and these tests pin the two rules that matter:
// non-verdicts are never evidence, and they are never silently lost.
// ---------------------------------------------------------------------------

function trace(assertions: TraceAssertion[]): TraceArtifact {
  return {
    schemaVersion: 2,
    proofId: "p1",
    timestamp: "2026-08-15T00:00:00.000Z",
    durationMs: 1,
    passed: assertions.every((a) => a.passed),
    steps: [
      {
        intent: "probe",
        kind: "tenant_isolation",
        target: "notifications",
        observation: "",
        passed: assertions.every((a) => a.passed),
        durationMs: 1,
        assertions,
      },
    ],
  };
}

const MANIFEST: MissionManifest = {
  schemaVersion: 1,
  missionId: "M-TEST",
  missionTitle: "Test mission",
  createdAt: "2026-08-15T00:00:00.000Z",
  requirements: {
    capabilities_must_exist: [],
    schema_must_contain: [],
    trace_must_prove: [
      {
        kind: "tenant_isolation",
        target: "notifications",
        role: "primary",
        description: "notifications must not be readable by another user",
      },
    ],
  },
};

function validate(traces: TraceArtifact[]) {
  const args = {
    manifest: MANIFEST,
    capabilities: { schemaVersion: 1, capabilities: [] },
    schema: { schemaVersion: 1, tables: [] },
    traces,
  };
  return validateMission(args);
}

describe("normalizeAssertionStatus", () => {
  it("keeps an explicit status", () => {
    expect(normalizeAssertionStatus("skipped", false)).toBe("skipped");
    expect(normalizeAssertionStatus("incomplete", false)).toBe("incomplete");
  });

  it("derives a status for assertions written before the field existed", () => {
    expect(normalizeAssertionStatus(undefined, true)).toBe("passed");
    expect(normalizeAssertionStatus(undefined, false)).toBe("failed");
  });

  it("ignores an unrecognized status rather than propagating it", () => {
    expect(normalizeAssertionStatus("banana", true)).toBe("passed");
  });
});

describe("assertion status as evidence", () => {
  it("does not let a skipped assertion satisfy a requirement", () => {
    const result = validate([
      trace([
        {
          kind: "tenant_isolation",
          target: "notifications",
          passed: false,
          status: "skipped",
          role: "primary",
          detail: "reverse direction not measured",
        },
      ]),
    ]);

    expect(result.ok).toBe(false);
    // Reported as a missing trace, not as a failed claim: the difference between
    // "we proved the opposite" and "we never looked" is what the status carries.
    expect(result.issues[0]?.category).toBe("trace_missing");
  });

  it("does not let an incomplete assertion satisfy a requirement", () => {
    const result = validate([
      trace([
        {
          kind: "tenant_isolation",
          target: "notifications",
          passed: false,
          status: "incomplete",
          role: "primary",
          detail: "no rows existed, so nothing could be observed",
        },
      ]),
    ]);

    expect(result.ok).toBe(false);
  });

  it("accepts a passing primary assertion alongside a skipped one", () => {
    // The realistic shape: isolation proven in one direction, the other skipped
    // for want of a fixture. The requirement is met, and the skip is still on
    // the record.
    const result = validate([
      trace([
        {
          kind: "tenant_isolation",
          target: "notifications",
          passed: true,
          status: "passed",
          role: "primary",
          emittedBy: "assert.tenantIsolation",
        },
        {
          kind: "tenant_isolation",
          target: "notifications",
          passed: false,
          status: "skipped",
          role: "primary",
        },
      ]),
    ]);

    expect(result.ok).toBe(true);
  });
});

describe("countAssertionStatuses (aggregate reporting)", () => {
  it("tallies each status so a skip is visible without reading every assertion", () => {
    expect(
      countAssertionStatuses(
        trace([
          {
            kind: "tenant_isolation",
            target: "t",
            passed: true,
            status: "passed",
          },
          {
            kind: "tenant_isolation",
            target: "t",
            passed: true,
            status: "passed",
          },
          {
            kind: "tenant_isolation",
            target: "t",
            passed: false,
            status: "skipped",
          },
          {
            kind: "tenant_isolation",
            target: "t",
            passed: false,
            status: "incomplete",
          },
          {
            kind: "tenant_isolation",
            target: "t",
            passed: false,
            status: "failed",
          },
        ]),
      ),
    ).toEqual({ passed: 2, failed: 1, incomplete: 1, skipped: 1 });
  });

  it("derives the tally the same way the SDK does for traces with no status", () => {
    const counts = countAssertionStatuses(
      trace([
        { kind: "tenant_isolation", target: "t", passed: true },
        { kind: "tenant_isolation", target: "t", passed: false },
      ]),
    );
    expect(counts).toEqual({ passed: 1, failed: 1, incomplete: 0, skipped: 0 });
    expect(normalizeAssertionStatus(undefined, true)).toBe("passed");
  });
});
