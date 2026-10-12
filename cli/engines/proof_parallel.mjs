import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  sourceHash,
  readTraceDirectory,
  decodeTraceBundle,
  isArtifactId,
} from "../../dist/node.js";
import {
  loadProofConfig,
  loadMutationCatalog,
  evidenceExclusions,
  assertArtifactDirectory,
} from "../config.mjs";
import { buildMutationInventory } from "./proof_inventory_build.mjs";
import { assertionSelectorsTurnedRed } from "./proof_control_sensitivity.mjs";
import {
  assignShards,
  digest,
  invariant,
  same,
  validateStages,
  validateExecution,
} from "./proof_parallel_contract.mjs";

const CLI = fileURLToPath(new URL("../proof-harness.mjs", import.meta.url));
const REPORTER = fileURLToPath(
  new URL("./proof_execution_reporter.mjs", import.meta.url),
);
const VERSION = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
const read = (file) => {
  invariant(
    fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),
    "expected regular evidence file",
  );
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const relative = (root, file) =>
  path.relative(root, file).split(path.sep).join("/");
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function argsOf(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    invariant(
      [
        "--plan",
        "--shard",
        "--shards",
        "--out",
        "--inputs",
        "--controls-config",
        "--history",
      ].includes(argv[i]) &&
        argv[i + 1] &&
        !argv[i + 1].startsWith("--") &&
        options[argv[i]] === undefined,
      `invalid argument ${argv[i]}`,
    );
    options[argv[i]] = argv[i + 1];
  }
  return options;
}
function command(config, command, args = [], env = {}) {
  const result = spawnSync(
    process.execPath,
    [CLI, "--config", config.configPath, command, ...args],
    { cwd: config.rootDir, env: { ...process.env, ...env }, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status === 0;
}
function git(config, args) {
  const result = spawnSync("git", args, {
    cwd: config.rootDir,
    encoding: "utf8",
  });
  invariant(result.status === 0, "a Git checkout is required");
  return result.stdout.trim();
}
function artifactRoot(config) {
  const root = path.resolve(config.rootDir, config.artifacts.parallel);
  assertArtifactDirectory(root, config.rootDir);
  return root;
}
function within(root, file) {
  const rel = path.relative(root, path.resolve(file));
  invariant(
    rel && !rel.startsWith("..") && !path.isAbsolute(rel),
    "parallel output must be inside artifacts.parallel",
  );
  let current = path.resolve(file);
  while (current !== root) {
    if (fs.existsSync(current))
      invariant(
        !fs.lstatSync(current).isSymbolicLink(),
        "symlink in parallel output",
      );
    current = path.dirname(current);
  }
  return path.resolve(file);
}
function checks(config) {
  const values = config.parallel?.postChecks;
  invariant(
    Array.isArray(values) &&
      values.length > 0 &&
      values.every(
        (v) =>
          Array.isArray(v) &&
          v.length > 0 &&
          v.every((s) => typeof s === "string" && s.length > 0),
      ),
    "parallel.postChecks must declare consumer-owned commands (argv arrays)",
  );
  return values;
}
function fileDigest(config, file, required = true) {
  const full = path.resolve(config.rootDir, file);
  if (!fs.existsSync(full)) {
    invariant(!required, `missing input ${file}`);
    return null;
  }
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(full))
    .digest("hex");
}
async function inputs(config, controlsPath) {
  invariant(
    config.configPath,
    "parallel execution requires an explicit repository config",
  );
  const controls = await loadProofConfig({
    cwd: config.rootDir,
    configPath: controlsPath,
  });
  invariant(
    controls.rootDir === config.rootDir,
    "control config must use the same checkout",
  );
  same(controls.artifacts, config.artifacts, "control artifact paths");
  same(controls.policies, config.policies, "control policies");
  same(controls.roots, config.roots, "control roots");
  invariant(controls.controlSensitivityCatalog, "missing control catalog");
  const primary = await loadMutationCatalog(config);
  const control = await loadMutationCatalog({
    ...controls,
    mutationCatalog: controls.controlSensitivityCatalog,
  });
  for (const catalog of [primary, control]) {
    invariant(
      new Set(catalog.map((m) => m.id)).size === catalog.length,
      "duplicate catalog id",
    );
    invariant(
      catalog.every((m) => isArtifactId(m.id) && typeof m.spec === "string"),
      "invalid catalog identity",
    );
  }
  checks(config);
  const hash = sourceHash(config.rootDir, evidenceExclusions(config));
  invariant(hash, "source identity missing");
  const identity = {
    repository:
      process.env.GITHUB_REPOSITORY ??
      git(config, ["remote", "get-url", "origin"]),
    commit: git(config, ["rev-parse", "HEAD"]),
    sourceHash: hash,
    harness: VERSION,
    runId: process.env.GITHUB_RUN_ID || process.env.PROOF_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    lockfile: fileDigest(config, config.repository.lockfile),
    schema: fileDigest(config, config.artifacts.schema),
    capabilities: fileDigest(config, config.artifacts.capabilities),
    config: fileDigest(config, config.configPath),
    controlsConfig: fileDigest(config, controls.configPath),
    catalogs: digest({ primary, control }),
    policies: Object.fromEntries(
      Object.entries(config.policies).map(([k, v]) => [
        k,
        fileDigest(config, v, k === "mutation"),
      ]),
    ),
    postChecks: digest(checks(config)),
  };
  invariant(
    typeof identity.runId === "string" && identity.runId.length > 0,
    "set PROOF_RUN_ID for local parallel runs",
  );
  return { identity, controls, primary, control };
}
function discover(config, file) {
  const token = crypto.randomUUID();
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--project=proofs",
      "--list",
      `--reporter=${REPORTER}`,
    ],
    {
      cwd: config.rootDir,
      stdio: "inherit",
      env: {
        ...process.env,
        PROOF_EXECUTION_REPORT: file,
        PROOF_EXECUTION_TOKEN: token,
      },
    },
  );
  invariant(result.status === 0, "Playwright discovery failed");
  const report = read(file);
  invariant(
    report.token === token &&
      report.errors.length === 0 &&
      report.tests.length > 0,
    "invalid Playwright discovery",
  );
  invariant(
    report.tests.every(
      (t) =>
        t.id.startsWith("proofs:") &&
        t.spec.endsWith(".proof.ts") &&
        !t.spec.startsWith("../"),
    ),
    "only proof project tests are supported; dependencies need their own explicit setup",
  );
  invariant(
    new Set(report.tests.map((t) => t.id)).size === report.tests.length,
    "duplicate discovered test",
  );
  return report.tests.map(({ id, spec, title }) => ({ id, spec, title }));
}
function treeDigest(directory) {
  if (!fs.existsSync(directory)) return digest([]);
  const files = fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((e) => ({ entry: e, file: path.join(e.parentPath, e.name) }));
  invariant(
    files.every(({ entry }) => !entry.isSymbolicLink()),
    "symlink in evidence",
  );
  return digest(
    files
      .filter(({ entry }) => entry.isFile())
      .map(({ file }) => [
        relative(directory, file),
        crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
function environment() {
  // Hash descriptors rather than persisting URLs or credentials in artifacts.
  return digest({
    host: os.hostname(),
    server: process.env.DEV_SERVER ?? "http://localhost:3000",
    database: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
  });
}
function scopedInventory(
  config,
  catalog,
  controlSensitivity,
  tracesDir,
  specs = null,
) {
  const inventory = buildMutationInventory({
    config,
    mutations: catalog,
    controlSensitivity,
    tracesDir,
    specs,
  });
  invariant(inventory.problems.length === 0, inventory.problems.join("; "));
  invariant(
    inventory.mutations.every(
      (m) =>
        isArtifactId(m.id) &&
        (controlSensitivity
          ? m.resolvedControls?.length
          : m.resolvedClaims?.length),
    ),
    "mutation lacks fresh mapped baseline evidence",
  );
  return inventory;
}
function assertBaseline(config, plan, shard, dir, report, token) {
  const tests = plan.tests.filter((t) => shard.specs.includes(t.spec));
  validateExecution(report, tests, { token });
  const traces = readTraceDirectory(dir, {
    rootDir: config.rootDir,
    excludedPaths: evidenceExclusions(config),
  });
  invariant(traces.length > 0, "empty baseline");
  for (const t of traces) {
    invariant(
      !t.mutation && t.passed && shard.specs.includes(t.specFile),
      "invalid baseline trace",
    );
    invariant(
      t.sourceHash === plan.identity.sourceHash &&
        t.commit === plan.identity.commit,
      "baseline identity",
    );
    const test = report.tests.find(
      (test) => test.id === t.executionId && test.spec === t.specFile,
    );
    invariant(
      test && (t.retry ?? 0) === test.attempts.at(-1).retry,
      "trace lacks matching test execution",
    );
  }
  invariant(
    tests.every((test) => traces.some((t) => t.executionId === test.id)),
    "executed test lacks trace evidence",
  );
  return traces;
}
async function createPlan(config, options) {
  invariant(options["--controls-config"], "--controls-config is required");
  const input = await inputs(config, options["--controls-config"]);
  const root = artifactRoot(config);
  const out = within(root, options["--out"] ?? path.join(root, "plan.json"));
  invariant(
    !fs.existsSync(out),
    "plan already exists; use a fresh output location",
  );
  fs.mkdirSync(root, { recursive: true });
  const discoveryFile = path.join(
    root,
    `discovery-${crypto.randomUUID()}.json`,
  );
  let tests;
  try {
    tests = discover(config, discoveryFile);
  } finally {
    fs.rmSync(discoveryFile, { force: true });
  }
  const specs = [...new Set(tests.map((t) => t.spec))].sort();
  invariant(
    [...input.primary, ...input.control].every((m) => specs.includes(m.spec)),
    "catalog references an undiscovered spec",
  );
  let history = {};
  if (options["--history"]) {
    try {
      history = read(options["--history"]).specDurationsMs ?? {};
    } catch {
      console.warn("[proof:plan] ignoring unreadable timing history");
    }
  }
  const groups = specs.map((spec) => {
    const mutations = [...input.primary, ...input.control].filter(
      (m) => m.spec === spec,
    );
    const estimate =
      30_000 +
      mutations.reduce(
        (sum, m) => sum + (m.subject?.kind === "sourceFile" ? 90_000 : 30_000),
        0,
      );
    return {
      spec,
      weight:
        Number.isFinite(history[spec]) && history[spec] > 0
          ? history[spec]
          : estimate,
    };
  });
  const contents = {
    schemaVersion: 1,
    kind: "proof-parallel-plan",
    identity: input.identity,
    controlsConfig: relative(config.rootDir, input.controls.configPath),
    tests,
    shards: assignShards(groups, Number(options["--shards"] ?? 6)),
  };
  write(out, { ...contents, id: digest(contents) });
  console.log(
    `[proof:plan] ${tests.length} tests / ${specs.length} specs assigned to ${contents.shards.length} isolated runners → ${out}`,
  );
  console.log(
    "[proof:plan] weights are scheduling estimates, not evidence or runtime guarantees",
  );
}
async function loadPlan(config, file) {
  invariant(file, "--plan is required");
  const plan = read(file);
  const { id, ...contents } = plan;
  invariant(
    plan.schemaVersion === 1 &&
      plan.kind === "proof-parallel-plan" &&
      id === digest(contents),
    "malformed plan",
  );
  const input = await inputs(config, plan.controlsConfig);
  same(input.identity, plan.identity, "plan input identity");
  invariant(
    Array.isArray(plan.tests) &&
      plan.tests.length > 0 &&
      new Set(plan.tests.map((t) => t.id)).size === plan.tests.length,
    "invalid plan tests",
  );
  const specs = plan.shards.flatMap((s) => s.specs);
  same(
    [...specs].sort(),
    [...new Set(plan.tests.map((t) => t.spec))].sort(),
    "plan spec assignment",
  );
  invariant(
    plan.shards.every((s, i) => s.index === i && s.specs.length > 0),
    "invalid shards",
  );
  return { plan, input };
}
async function runStage(config, stage, options) {
  const { plan, input } = await loadPlan(config, options["--plan"]);
  invariant(
    options["--shard"] !== undefined,
    "--shard is required (zero based)",
  );
  const index = Number(options["--shard"]);
  const shard = plan.shards[index];
  invariant(Number.isInteger(index) && shard, "unknown shard");
  const root = artifactRoot(config);
  const dir = within(root, path.join(root, `shard-${index}`));
  fs.mkdirSync(dir, { recursive: true });
  const recordPath = path.join(dir, `${stage}.json`);
  invariant(
    stage === "finalize" || !fs.existsSync(path.join(dir, "finalize.json")),
    "no execution may follow finalization",
  );
  invariant(
    !fs.existsSync(recordPath),
    "stage already ran; use a fresh CI attempt and plan",
  );
  const leasePath = path.join(root, "environment.json");
  if (stage === "verify")
    write(leasePath, {
      planId: plan.id,
      shard: index,
      environmentId: environment(),
    });
  same(
    read(leasePath),
    { planId: plan.id, shard: index, environmentId: environment() },
    "checkout isolation lease",
  );
  const start = performance.now();
  const baseline =
    stage === "verify"
      ? { environmentId: environment(), baselineId: crypto.randomUUID() }
      : read(path.join(dir, "verify.json"));
  invariant(
    baseline.environmentId === environment(),
    "shard moved to another environment",
  );
  if (stage !== "verify" && stage !== "finalize") {
    invariant(
      baseline.planId === plan.id && baseline.passed === true,
      "fresh passing baseline required",
    );
    same(
      treeDigest(path.join(dir, "traces")),
      baseline.evidenceHash,
      "baseline artifacts",
    );
  }
  const record = {
    schemaVersion: 1,
    kind: "proof-shard-stage",
    planId: plan.id,
    identity: plan.identity,
    shard: index,
    environmentId: baseline.environmentId,
    baselineId: baseline.baselineId,
    stage,
    passed: false,
    durationMs: 0,
  };
  const specArgs = shard.specs.flatMap((spec) => ["--spec", spec]);
  const traces = path.join(dir, "traces");
  const token = `${baseline.baselineId}:${stage}`;
  const lock = path.join(root, "active-stage.lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({ planId: plan.id, shard: index, stage }),
    { flag: "wx" },
  );
  try {
    if (stage === "verify") {
      record.passed = command(
        config,
        "verify",
        ["--traces-dir", traces, ...specArgs],
        {
          PROOF_EXECUTION_REPORT: path.join(dir, "execution.json"),
          PROOF_EXECUTION_TOKEN: token,
        },
      );
      invariant(record.passed, "baseline command failed");
      assertBaseline(
        config,
        plan,
        shard,
        traces,
        read(path.join(dir, "execution.json")),
        token,
      );
      record.evidenceHash = treeDigest(traces);
      record.executionHash = fileDigest(
        config,
        path.join(dir, "execution.json"),
      );
    } else if (stage === "mutate" || stage === "controls") {
      const control = stage === "controls";
      scopedInventory(
        control ? input.controls : config,
        control ? input.control : input.primary,
        control,
        traces,
        shard.specs,
      );
      record.passed = command(
        control ? input.controls : config,
        stage,
        [
          "--baseline-dir",
          traces,
          "--output-dir",
          path.join(dir, `${stage}-artifacts`),
          ...specArgs,
        ],
        {
          PROOF_EXECUTION_TOKEN: token,
          PROOF_REQUIRE_OWNED_SERVER: "true",
          PROOF_COMMIT: plan.identity.commit,
        },
      );
      record.evidenceHash = treeDigest(path.join(dir, `${stage}-artifacts`));
      invariant(record.passed, `${stage} failed`);
    } else {
      record.checks = [];
      for (const argv of checks(config)) {
        const checkStart = performance.now();
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: config.rootDir,
          stdio: "inherit",
          env: process.env,
        });
        record.checks.push({
          argv,
          passed: result.status === 0,
          durationMs: performance.now() - checkStart,
        });
      }
      invariant(
        !fs.existsSync(
          path.resolve(
            config.rootDir,
            path.dirname(config.artifacts.mutations),
            "mutation-recovery.json",
          ),
        ),
        "unrecovered mutation journal",
      );
      for (const previous of ["mutate", "controls"]) {
        const completed = read(path.join(dir, `${previous}.json`));
        invariant(
          completed.planId === plan.id &&
            completed.baselineId === baseline.baselineId &&
            completed.environmentId === baseline.environmentId,
          "finalize requires completed mutation and control stages from this environment",
        );
      }
      invariant(
        record.checks.every((c) => c.passed),
        "consumer postcheck failed",
      );
      record.passed = true;
    }
    const after = await inputs(config, plan.controlsConfig);
    same(after.identity, plan.identity, "restored source and inputs");
  } catch (error) {
    record.passed = false;
    record.error = String(error?.message ?? error);
    throw error;
  } finally {
    record.durationMs = performance.now() - start;
    try {
      write(recordPath, record);
    } finally {
      fs.unlinkSync(lock);
    }
  }
}
function assessMutations(
  config,
  plan,
  shard,
  stage,
  directory,
  baselineId,
  expected,
) {
  const summary = read(path.join(directory, "summary.json"));
  const control = stage === "controls";
  invariant(
    summary.schemaVersion === 1 &&
      summary.mode === (control ? "control-sensitivity" : "primary-mutation"),
    "mutation summary mode",
  );
  const results = control ? summary.controls : summary.mutations;
  invariant(Array.isArray(results), "missing mutation results");
  const allowed = new Set([
    "summary.json",
    ".proof-harness-owned",
    ".runs",
    ...expected.map((m) => m.id),
  ]);
  invariant(
    fs.readdirSync(directory).every((name) => allowed.has(name)),
    "unexpected mutation artifacts",
  );
  const runs = path.join(directory, ".runs");
  if (fs.existsSync(runs)) {
    const expectedRuns = expected
      .flatMap((m) => [m.id, `${m.id}-execution.json`, `${m.id}-output.txt`])
      .sort();
    same(
      fs.readdirSync(runs).sort(),
      expectedRuns,
      "mutation execution artifacts",
    );
  }
  same(
    results.map((r) => r.id).sort(),
    expected.map((m) => m.id).sort(),
    "complete mutation inventory",
  );
  for (const mutation of expected) {
    const result = results.find((r) => r.id === mutation.id);
    invariant(
      !result.error &&
        result.restoration === "verified" &&
        result.cleanupErrors?.length === 0 &&
        result.plantVerified === true &&
        result.liveVerified === true &&
        result.timedOut === false &&
        result.exitCode !== null &&
        result.playwrightFailed === true,
      "mutation lifecycle failed",
    );
    const traces = readTraceDirectory(
      path.join(directory, ".runs", mutation.id),
      { checkFreshness: false },
    );
    invariant(
      traces.length > 0 &&
        traces.every(
          (t) =>
            t.specFile === mutation.spec &&
            t.specHash === fileDigest(config, mutation.spec).slice(0, 12) &&
            t.mutation?.id === mutation.id &&
            t.mutation.planted === true,
        ),
      "mutation trace identity",
    );
    invariant(
      typeof result.executionSourceHash === "string" &&
        traces.every(
          (t) =>
            t.sourceHash === result.executionSourceHash &&
            t.commit === plan.identity.commit,
        ),
      "mutation source identity",
    );
    if (mutation.subject.kind !== "sourceFile")
      same(
        result.executionSourceHash,
        plan.identity.sourceHash,
        "database mutation source",
      );
    const selectors = control
      ? mutation.resolvedControls
      : (mutation.claims ?? mutation.resolvedClaims);
    invariant(
      assertionSelectorsTurnedRed(
        traces,
        selectors,
        control ? "control" : "primary",
        control ? mutation.expectedFailureCode : undefined,
      ),
      "mapped assertion did not fail",
    );
    const report = read(
      path.join(directory, ".runs", `${mutation.id}-execution.json`),
    );
    validateExecution(
      report,
      plan.tests.filter((t) => t.spec === mutation.spec),
      { token: `${baselineId}:${stage}`, baseline: false },
    );
    invariant(report.status === "failed", "mutation test run did not fail");
    invariant(
      traces.every(
        (t) =>
          report.tests.some(
            (test) => test.id === t.executionId && test.spec === t.specFile,
          ) && (t.retry ?? 0) === 0,
      ),
      "mutation trace execution identity",
    );
    invariant(
      result.outcome === "detected" && result.reasonOk === true,
      "mutation outcome disagrees with evidence",
    );
    const output = fs.readFileSync(
      path.join(directory, ".runs", `${mutation.id}-output.txt`),
      "utf8",
    );
    invariant(
      !mutation.expectFailureContains ||
        output.includes(mutation.expectFailureContains),
      "mutation failed for wrong reason",
    );
    invariant(shard.specs.includes(mutation.spec), "unexpected mutation spec");
  }
  return results;
}
async function aggregate(config, options) {
  const { plan, input } = await loadPlan(config, options["--plan"]);
  invariant(options["--inputs"], "--inputs directory required");
  const root = path.resolve(options["--inputs"]);
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.name.startsWith("shard-"));
  invariant(
    entries.every((e) => e.isDirectory() && !e.isSymbolicLink()),
    "invalid shard directory",
  );
  same(
    entries.map((e) => e.name).sort(),
    plan.shards.map((s) => `shard-${s.index}`).sort(),
    "input shard directories",
  );
  const records = plan.shards.flatMap((s) =>
    ["verify", "mutate", "controls", "finalize"].map((stage) =>
      read(path.join(root, `shard-${s.index}`, `${stage}.json`)),
    ),
  );
  validateStages(plan, records);
  const combined = [];
  for (const shard of plan.shards) {
    const dir = path.join(root, `shard-${shard.index}`);
    const baseline = records.find(
      (r) => r.shard === shard.index && r.stage === "verify",
    );
    same(
      treeDigest(path.join(dir, "traces")),
      baseline.evidenceHash,
      "baseline artifact hash",
    );
    same(
      fileDigest(config, path.join(dir, "execution.json")),
      baseline.executionHash,
      "baseline execution hash",
    );
    combined.push(
      ...assertBaseline(
        config,
        plan,
        shard,
        path.join(dir, "traces"),
        read(path.join(dir, "execution.json")),
        `${baseline.baselineId}:verify`,
      ),
    );
    const finalize = records.find(
      (r) => r.shard === shard.index && r.stage === "finalize",
    );
    same(
      finalize.checks.map((c) => c.argv),
      checks(config),
      "postcheck commands",
    );
    invariant(
      finalize.checks.every((c) => c.passed === true),
      "failed postcheck",
    );
  }
  decodeTraceBundle(combined); // Detect collisions across otherwise valid shards.
  const out = path.join(
    artifactRoot(config),
    `aggregate-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(out, { recursive: true });
  for (const trace of combined)
    write(path.join(out, `${trace.proofId}.json`), trace);
  const primary = scopedInventory(config, input.primary, false, out);
  const control = scopedInventory(input.controls, input.control, true, out);
  // Re-discover to detect a plan that omitted tests, independently of shard results.
  const discovery = path.join(
    artifactRoot(config),
    `discovery-${crypto.randomUUID()}.json`,
  );
  try {
    same(discover(config, discovery), plan.tests, "complete test discovery");
  } finally {
    fs.rmSync(discovery, { force: true });
  }
  const specDurationsMs = {};
  for (const shard of plan.shards) {
    const dir = path.join(root, `shard-${shard.index}`);
    const baseline = records.find(
      (r) => r.shard === shard.index && r.stage === "verify",
    );
    const report = read(path.join(dir, "execution.json"));
    for (const test of report.tests)
      specDurationsMs[test.spec] =
        (specDurationsMs[test.spec] ?? 0) +
        test.attempts.reduce((n, a) => n + a.durationMs, 0);
    for (const stage of ["mutate", "controls"]) {
      const directory = path.join(dir, `${stage}-artifacts`);
      same(
        treeDigest(directory),
        records.find((r) => r.shard === shard.index && r.stage === stage)
          .evidenceHash,
        "mutation artifacts",
      );
      const inventory = stage === "controls" ? control : primary;
      const expected = inventory.mutations.filter((m) =>
        shard.specs.includes(m.spec),
      );
      const results = assessMutations(
        config,
        plan,
        shard,
        stage,
        directory,
        baseline.baselineId,
        expected,
      );
      for (const r of results)
        specDurationsMs[r.spec] =
          (specDurationsMs[r.spec] ?? 0) +
          Object.values(r.timings).reduce((a, b) => a + b, 0);
    }
  }
  invariant(
    command(config, "coverage", ["--strict", "--traces-dir", out]),
    "strict coverage failed",
  );
  // Full mission requirements are assessed only after the complete baseline is assembled.
  invariant(
    command(config, "verify", ["--no-run", "--traces-dir", out]),
    "full mission verification failed",
  );
  const summary = {
    schemaVersion: 1,
    kind: "proof-parallel-acceptance",
    planId: plan.id,
    identity: plan.identity,
    passed: true,
    tests: plan.tests.length,
    mutations: primary.mutations.length,
    controls: control.mutations.length,
    claims: primary.claims.length,
    acceptedClaims: primary.acceptedClaims.length,
    specDurationsMs,
    stages: records.map(({ shard, stage, durationMs }) => ({
      shard,
      stage,
      durationMs,
    })),
  };
  const laneDurations = plan.shards.map((s) =>
    records
      .filter((r) => r.shard === s.index)
      .reduce((sum, r) => sum + r.durationMs, 0),
  );
  summary.slowestLaneMs = Math.max(...laneDurations);
  summary.totalRunnerMs = laneDurations.reduce((a, b) => a + b, 0);
  summary.slowestSpecs = Object.entries(specDurationsMs)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([spec, durationMs]) => ({ spec, durationMs }));
  summary.timingScope =
    "package stages only; CI install, preflight, queue and artifact transfer time are additional";
  if (summary.slowestLaneMs >= 18 * 60 * 1000)
    console.warn(
      "[proof:aggregate] slowest lane exceeds 18 minutes before CI overhead; inspect slowestSpecs and rebalance",
    );
  write(path.join(out, "acceptance.json"), summary);
  console.log(
    `[proof:aggregate] complete gate passed → ${out}/acceptance.json`,
  );
}
export async function runParallel(config, command, argv) {
  process.chdir(config.rootDir);
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log(`Usage:
  proof-harness plan --shards <count> --controls-config <path> [--out <path>] [--history <report>]
  proof-harness verify|mutate|controls|finalize --plan <path> --shard <zero-based-index>
  proof-harness aggregate --plan <path> --inputs <directory>

Requires separate checkout/database/server environments and consumer-owned
parallel.postChecks. Only aggregate assesses the complete release gate.
See COMPATIBILITY.md for integration and fresh-run requirements.`);
    return;
  }
  const options = argsOf(argv);
  const allowed =
    command === "plan"
      ? ["--shards", "--controls-config", "--out", "--history"]
      : command === "aggregate"
        ? ["--plan", "--inputs"]
        : ["--plan", "--shard"];
  invariant(
    Object.keys(options).every((key) => allowed.includes(key)),
    "flag not supported by this parallel command",
  );
  if (command === "plan") return createPlan(config, options);
  if (command === "aggregate") return aggregate(config, options);
  invariant(
    ["verify", "mutate", "controls", "finalize"].includes(command),
    "unsupported parallel command",
  );
  return runStage(config, command, options);
}
