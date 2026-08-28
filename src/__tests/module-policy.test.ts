// Import External Packages
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import {
  evaluateModulePolicy,
  readModulePolicy,
} from "../../cli/engines/proof_module_check.mjs";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// `.proof/module-policy.json` turns the descriptor gate from a wall into a
// ratchet (issue #11): an undescribed module may be accepted with a written
// reason, and an acceptance that no longer applies fails as stale so
// paid-down debt leaves the file. These tests pin that lifecycle.
// ---------------------------------------------------------------------------

const POLICY_PATH = ".proof/module-policy.json";

const onboarding = {
  root: "app/__business-logic",
  name: "onboarding",
  kind: "business",
};

function policyWith(entries: unknown[]) {
  return { schemaVersion: 1, acceptedUndescribed: entries };
}

describe("evaluateModulePolicy", () => {
  it("fails an undescribed module with no acceptance, pointing at both remedies", () => {
    const { problems, accepted } = evaluateModulePolicy({
      missing: [onboarding],
      described: new Set(["auth"]),
      policy: policyWith([]),
      policyPath: POLICY_PATH,
    });
    expect(accepted).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0].category).toBe("module_missing");
    expect(problems[0].suggestion).toContain(POLICY_PATH);
  });

  it("passes an undescribed module accepted with a reason, and reports it", () => {
    const entry = {
      module: "app/__business-logic/onboarding",
      reason: "Baseline debt recorded at adoption; descriptor scheduled.",
    };
    const { problems, accepted } = evaluateModulePolicy({
      missing: [onboarding],
      described: new Set(["auth"]),
      policy: policyWith([entry]),
      policyPath: POLICY_PATH,
    });
    expect(problems).toEqual([]);
    expect(accepted).toEqual([entry]);
  });

  it("rejects an entry without a written reason", () => {
    const { problems } = evaluateModulePolicy({
      missing: [onboarding],
      described: new Set(),
      policy: policyWith([
        { module: "app/__business-logic/onboarding", reason: "  " },
      ]),
      policyPath: POLICY_PATH,
    });
    expect(
      problems.some(
        (p: { category: string }) => p.category === "module_policy",
      ),
    ).toBe(true);
    // The malformed entry must not silently accept the module.
    expect(
      problems.some(
        (p: { category: string }) => p.category === "module_missing",
      ),
    ).toBe(true);
  });

  it("rejects duplicate entries for the same module", () => {
    const entry = {
      module: "app/__business-logic/onboarding",
      reason: "recorded",
    };
    const { problems } = evaluateModulePolicy({
      missing: [onboarding],
      described: new Set(),
      policy: policyWith([entry, { ...entry }]),
      policyPath: POLICY_PATH,
    });
    expect(
      problems.some((p: { message: string }) =>
        p.message.includes("duplicate"),
      ),
    ).toBe(true);
  });

  it("fails a stale acceptance once the module gains a descriptor", () => {
    const { problems } = evaluateModulePolicy({
      missing: [],
      described: new Set(["onboarding"]),
      policy: policyWith([
        { module: "app/__business-logic/onboarding", reason: "recorded" },
      ]),
      policyPath: POLICY_PATH,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].category).toBe("module_policy_stale");
    expect(problems[0].message).toContain("now has a descriptor");
  });

  it("fails a stale acceptance for a module directory that no longer exists", () => {
    const { problems } = evaluateModulePolicy({
      missing: [],
      described: new Set(),
      policy: policyWith([
        { module: "app/__business-logic/deleted-module", reason: "recorded" },
      ]),
      policyPath: POLICY_PATH,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].category).toBe("module_policy_stale");
    expect(problems[0].message).toContain("delete or fix");
  });
});

describe("readModulePolicy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-module-policy-"));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats an absent file as an empty policy without complaint", () => {
    const { policy, problems } = readModulePolicy(path.join(dir, "none.json"));
    expect(problems).toEqual([]);
    expect(policy.acceptedUndescribed).toEqual([]);
  });

  it("fails closed on malformed JSON", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not json", "utf8");
    const { policy, problems } = readModulePolicy(file);
    expect(problems).toHaveLength(1);
    expect(problems[0].category).toBe("module_policy");
    expect(policy.acceptedUndescribed).toEqual([]);
  });

  it("fails closed on an unsupported schemaVersion", () => {
    const file = path.join(dir, "wrong-version.json");
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2 }), "utf8");
    const { problems } = readModulePolicy(file);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain("schemaVersion");
  });
});
