import fs from "node:fs";
import { expect, it } from "vitest";
import {
  assignShards,
  validateStages,
} from "../cli/engines/proof_parallel_contract.mjs";
const contract = JSON.parse(
  fs.readFileSync("proof-consumer-fixtures/parallel/contract.json", "utf8"),
);
it("assigns whole specs deterministically, including specs without mutations", () => {
  const groups = [
    { spec: "a", weight: 9 },
    { spec: "b", weight: 5 },
    { spec: "c", weight: 4 },
  ];
  expect(assignShards(groups, 2)).toEqual(
    assignShards([...groups].reverse(), 2),
  );
  expect(assignShards(groups, 2).map((s) => s.specs)).toEqual([
    ["a"],
    ["b", "c"],
  ]);
  expect(() => assignShards(groups, 4)).toThrow();
});
it("rejects missing, duplicate, cross-attempt, cross-environment and failed stage evidence", () => {
  const plan = {
    id: "plan",
    identity: { runId: "1", attempt: "1" },
    shards: [{ index: 0, specs: ["a"] }],
  };
  const stages = contract.stages.map((stage: string) => ({
    schemaVersion: 1,
    kind: "proof-shard-stage",
    planId: "plan",
    identity: plan.identity,
    shard: 0,
    environmentId: "env",
    baselineId: "base",
    stage,
    passed: true,
    durationMs: 1,
  }));
  expect(() => validateStages(plan, stages)).not.toThrow();
  expect(() => validateStages(plan, stages.slice(1))).toThrow();
  expect(() => validateStages(plan, [...stages, stages[0]])).toThrow();
  for (const patch of [
    { identity: { runId: "1", attempt: "2" } },
    { environmentId: "other" },
    { baselineId: "other" },
    { passed: false },
    { durationMs: -1 },
    { shard: 1 },
  ]) {
    expect(() =>
      validateStages(plan, [{ ...stages[0], ...patch }, ...stages.slice(1)]),
    ).toThrow();
  }
});

it("requires all discovered baseline tests while retaining retry attempts", async () => {
  const { validateExecution } = await import(
    "../cli/engines/proof_parallel_contract.mjs"
  );
  const tests = [{ id: "proofs:one:0", spec: "a.proof.ts" }];
  const report = {
    schemaVersion: 1,
    token: "baseline",
    status: "passed",
    errors: [],
    tests: [
      {
        ...tests[0],
        expectedStatus: "passed",
        attempts: [
          { retry: 0, status: "failed", durationMs: 10 },
          { retry: 1, status: "passed", durationMs: 10 },
        ],
      },
    ],
  };
  expect(() =>
    validateExecution(report, tests, { token: "baseline" }),
  ).not.toThrow();
  for (const testsOverride of [
    [],
    [...report.tests, ...report.tests],
    [{ ...report.tests[0], attempts: [] }],
    [
      {
        ...report.tests[0],
        attempts: [{ retry: 0, status: "skipped", durationMs: 0 }],
      },
    ],
  ]) {
    expect(() =>
      validateExecution({ ...report, tests: testsOverride }, tests, {
        token: "baseline",
      }),
    ).toThrow();
  }
  expect(() => validateExecution(report, tests, { token: "other" })).toThrow();
  expect(() =>
    validateExecution({ ...report, status: "failed" }, tests, {
      token: "baseline",
      baseline: false,
    }),
  ).toThrow();
});

it("derives automatic mutations from scoped baselines and rederives the complete inventory", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: crypto } = await import("node:crypto");
  const { loadProofConfig } = await import("../cli/config.mjs");
  const { buildMutationInventory } = await import(
    "../cli/engines/proof_inventory_build.mjs"
  );
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "proof-scoped-inventory-"),
  );
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(
      path.join(root, file),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  try {
    write(".proof/schema.json", {
      tables: [
        { name: "a", rls_classification: "user_scoped" },
        { name: "b", rls_classification: "workspace_scoped" },
      ],
    });
    write(".proof/mutation-policy.json", {
      schemaVersion: 1,
      acceptedClaims: [],
    });
    for (const name of ["a", "b"]) {
      const spec = `e2e/proofs/${name}.proof.ts`;
      write(spec, "// fixture");
      const trace = {
        schemaVersion: 2,
        proofId: name,
        specFile: spec,
        specHash: crypto
          .createHash("sha256")
          .update("// fixture")
          .digest("hex")
          .slice(0, 12),
        timestamp: new Date().toISOString(),
        durationMs: 1,
        passed: true,
        steps: [
          {
            kind: "tenant_isolation",
            target: name,
            intent: "isolation",
            observation: "denied",
            passed: true,
            durationMs: 1,
            assertions: [
              {
                kind: "tenant_isolation",
                target: name,
                operation: "select",
                passed: true,
                emittedBy: "assert.tenantIsolation",
              },
            ],
          },
        ],
      };
      write(`.proof/${name}/${name}.json`, trace);
      write(`.proof/all/${name}.json`, trace);
    }
    const config = await loadProofConfig({ cwd: root });
    const scoped = buildMutationInventory({
      config,
      mutations: [],
      tracesDir: ".proof/a",
      specs: ["e2e/proofs/a.proof.ts"],
    });
    expect(scoped.problems).toEqual([]);
    expect(scoped.mutations.map((m: { id: string }) => m.id)).toEqual([
      "AUTO-RLS-a-a",
    ]);
    const full = buildMutationInventory({
      config,
      mutations: [],
      tracesDir: ".proof/all",
    });
    expect(full.problems).toEqual([]);
    expect(full.mutations.map((m: { id: string }) => m.id)).toEqual([
      "AUTO-RLS-a-a",
      "AUTO-RLS-b-b",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
