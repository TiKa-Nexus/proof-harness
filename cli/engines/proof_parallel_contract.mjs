import crypto from "node:crypto";

export const STAGES = ["verify", "mutate", "controls", "finalize"];
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function invariant(condition, message) {
  if (!condition) throw new Error(`[PROOF_FAIL] parallel_evidence: ${message}`);
}
export function same(actual, expected, label) {
  invariant(digest(actual) === digest(expected), `${label} mismatch`);
}
export function assignShards(groups, count) {
  invariant(
    Number.isInteger(count) && count >= 1 && count <= groups.length,
    "shards must be between 1 and the number of proof specs",
  );
  invariant(
    new Set(groups.map((g) => g.spec)).size === groups.length,
    "duplicate spec",
  );
  invariant(
    groups.every(
      (g) =>
        typeof g.spec === "string" && Number.isFinite(g.weight) && g.weight > 0,
    ),
    "invalid spec weight",
  );
  const shards = Array.from({ length: count }, (_, index) => ({
    index,
    specs: [],
    weight: 0,
  }));
  for (const group of [...groups].sort(
    (a, b) => b.weight - a.weight || a.spec.localeCompare(b.spec),
  )) {
    const shard = [...shards].sort(
      (a, b) => a.weight - b.weight || a.index - b.index,
    )[0];
    shard.specs.push(group.spec);
    shard.weight += group.weight;
  }
  for (const shard of shards) shard.specs.sort();
  return shards;
}
export function validateStages(plan, records) {
  invariant(
    Array.isArray(records) &&
      records.length === plan.shards.length * STAGES.length,
    "missing or unexpected stages",
  );
  const seen = new Set();
  const environments = new Set();
  for (const shard of plan.shards) {
    const stages = records.filter((r) => r.shard === shard.index);
    invariant(stages.length === STAGES.length, "missing shard stages");
    const baseline = stages.find((r) => r.stage === "verify");
    invariant(
      baseline &&
        typeof baseline.environmentId === "string" &&
        baseline.environmentId.length > 0 &&
        typeof baseline.baselineId === "string" &&
        baseline.baselineId.length > 0,
      "missing baseline identity",
    );
    invariant(
      !environments.has(baseline.environmentId),
      "shared shard environment",
    );
    environments.add(baseline.environmentId);
    for (const record of stages) {
      const key = `${record.shard}:${record.stage}`;
      invariant(
        !seen.has(key) && STAGES.includes(record.stage),
        "duplicate or unknown stage",
      );
      seen.add(key);
      invariant(
        record.schemaVersion === 1 && record.kind === "proof-shard-stage",
        "unsupported stage contract",
      );
      invariant(record.planId === plan.id, "different plan");
      same(record.identity, plan.identity, "run identity");
      invariant(
        record.environmentId === baseline.environmentId &&
          record.baselineId === baseline.baselineId,
        "different environment or baseline",
      );
      invariant(record.passed === true, `failed ${key}`);
      invariant(
        Number.isFinite(record.durationMs) && record.durationMs >= 0,
        "invalid duration",
      );
    }
  }
}
export function validateExecution(
  report,
  tests,
  { token = /** @type {string | null} */ (null), baseline = true } = {},
) {
  invariant(
    report?.schemaVersion === 1 && report.token === token,
    "execution report identity",
  );
  same(
    report.tests
      .map(({ id, spec }) => ({ id, spec }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tests
      .map(({ id, spec }) => ({ id, spec }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    "discovered tests",
  );
  invariant(
    new Set(report.tests.map((t) => t.id)).size === report.tests.length,
    "duplicate test",
  );
  invariant(
    Array.isArray(report.errors) && report.errors.length === 0,
    "runner setup failure",
  );
  invariant(
    baseline
      ? report.status === "passed"
      : ["passed", "failed"].includes(report.status),
    "runner failed or interrupted",
  );
  for (const test of report.tests) {
    invariant(
      Array.isArray(test.attempts) && test.attempts.length > 0,
      "test did not execute",
    );
    invariant(
      test.attempts.every(
        (a, i) =>
          a.retry === i && Number.isFinite(a.durationMs) && a.durationMs >= 0,
      ),
      "invalid attempts",
    );
    if (baseline)
      invariant(
        test.expectedStatus === "passed" &&
          test.attempts.at(-1).status === "passed",
        "test skipped or did not pass",
      );
    else
      invariant(
        test.attempts.length === 1 &&
          ["passed", "failed"].includes(test.attempts[0].status),
        "mutation test skipped, timed out or retried",
      );
  }
}
