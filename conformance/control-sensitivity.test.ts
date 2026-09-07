import fs from "node:fs";
import { expect, it } from "vitest";
import {
  validateControlBaseline,
  assertionSelectorsTurnedRed,
} from "../cli/engines/proof_control_sensitivity.mjs";
const mutation = JSON.parse(
  fs.readFileSync(
    "proof-consumer-fixtures/control-sensitivity/catalog.json",
    "utf8",
  ),
);
const selector = mutation.controls[0];
const trace = (
  passed: boolean,
  role = "control",
  status = passed ? "passed" : "failed",
) => ({
  specFile: mutation.spec,
  passed,
  steps: [
    {
      passed,
      error: passed
        ? undefined
        : "[PROOF_FAIL] tenant_isolation_control: owner cannot read",
      assertions: [{ ...selector, passed, role, status }],
    },
  ],
});
it("requires a fresh passing mapped control baseline, never a primary or planted assertion", () => {
  expect(validateControlBaseline(mutation, [trace(true)])).toEqual(
    mutation.controls,
  );
  for (const traces of [
    [],
    [trace(false)],
    [trace(true, "primary")],
    [{ ...trace(true), mutation: { planted: true } }],
  ])
    expect(() => validateControlBaseline(mutation, traces)).toThrow(
      "control_baseline_missing",
    );
  expect(() =>
    validateControlBaseline({ ...mutation, claims: [selector] }, [trace(true)]),
  ).toThrow("control_contract");
});
it("keeps primary and control failures separate for the same assertion key", () => {
  expect(
    assertionSelectorsTurnedRed(
      [trace(false)],
      mutation.controls,
      "control",
      mutation.expectedFailureCode,
    ),
  ).toBe(true);
  expect(
    assertionSelectorsTurnedRed([trace(false)], mutation.controls, "primary"),
  ).toBe(false);
  expect(
    assertionSelectorsTurnedRed(
      [trace(false, "primary")],
      mutation.controls,
      "control",
      mutation.expectedFailureCode,
    ),
  ).toBe(false);
});
it.each(["incomplete", "skipped"])(
  "rejects %s controls as sensitivity evidence",
  (status) => {
    expect(
      assertionSelectorsTurnedRed(
        [trace(false, "control", status)],
        mutation.controls,
        "control",
        mutation.expectedFailureCode,
      ),
    ).toBe(false);
  },
);
it("rejects wrong failure categories, missing assertions and wrong helper origin", () => {
  const wrong = trace(false);
  wrong.steps[0].error = "[PROOF_FAIL] tenant_isolation_setup: unavailable";
  expect(
    assertionSelectorsTurnedRed(
      [wrong],
      mutation.controls,
      "control",
      mutation.expectedFailureCode,
    ),
  ).toBe(false);
  expect(
    assertionSelectorsTurnedRed(
      [{ ...trace(false), steps: [] }],
      mutation.controls,
      "control",
      mutation.expectedFailureCode,
    ),
  ).toBe(false);
  const forged = trace(false);
  forged.steps[0].assertions[0].emittedBy = "custom";
  expect(
    assertionSelectorsTurnedRed(
      [forged],
      mutation.controls,
      "control",
      mutation.expectedFailureCode,
    ),
  ).toBe(false);
});

it("runs the control inventory separately while the primary runner rejects an empty claim mapping", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(path.join(tmpdir(), "proof-control-cli-"));
  const write = (file: string, value: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  try {
    write("package.json", '{"type":"module"}');
    write(
      "proof.config.mjs",
      'export default {mutationCatalog:"catalog.mjs",controlSensitivityCatalog:"catalog.mjs"};',
    );
    write("catalog.mjs", `export default [${JSON.stringify(mutation)}];`);
    write(mutation.spec, "// fixture");
    write(".proof/schema.json", '{"schemaVersion":1,"tables":[]}');
    write(
      ".proof/traces/control.json",
      JSON.stringify({
        schemaVersion: 2,
        proofId: "control",
        specFile: mutation.spec,
        specHash: createHash("sha256")
          .update("// fixture")
          .digest("hex")
          .slice(0, 12),
        timestamp: new Date().toISOString(),
        durationMs: 1,
        passed: true,
        steps: [
          {
            intent: "owner can read",
            kind: "tenant_isolation",
            target: selector.target,
            observation: "owner read",
            durationMs: 1,
            passed: true,
            assertions: [
              { ...selector, passed: true, status: "passed", role: "control" },
            ],
          },
        ],
      }),
    );
    const cli = path.resolve("cli/proof-harness.mjs");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
      });
    const controls = run("controls", "--inventory");
    expect(controls.status, controls.stdout + controls.stderr).toBe(0);
    const primary = run("mutate", "--only", mutation.id);
    expect(primary.status, primary.stdout + primary.stderr).not.toBe(0);
    expect(primary.stderr).toContain("mutation_baseline_missing");
    write(mutation.spec, "// changed");
    const stale = run("controls", "--inventory");
    expect(stale.status).not.toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
