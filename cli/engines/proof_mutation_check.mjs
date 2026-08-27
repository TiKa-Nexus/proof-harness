#!/usr/bin/env node
// ---------------------------------------------------------------------------
// proof_mutation_check.mjs
//
// Who watches the watchmen.
//
// A proof suite that passes tells you nothing on its own — a suite that has
// quietly stopped being able to fail passes too. This script deliberately
// re-opens each vulnerability the baseline proofs exist to catch, confirms the
// corresponding proof turns RED, and then reverts. If a proof stays green while
// its vulnerability is live, that proof is decorative and this script fails.
//
// Mutations are applied to the DATABASE, not the source tree: they are precise,
// instant and reversible, where patching SQL files would require a full
// migration cycle per mutation. Migrations are never (re)applied by this
// script; each planted defect is read back after apply and again after the
// proof, so a plant that never took effect — or was externally undone
// mid-run — fails as its own finding instead of being blamed on the proof.
//
// The mutation list is also the honest answer to "what does the baseline suite
// actually detect?" — each entry names a finding, the hole it re-opens, and the
// proof expected to notice.
//
// Usage:
//   node scripts/proof_mutation_check.mjs            # every mutation
//   node scripts/proof_mutation_check.mjs --inventory # validate, change nothing
//   node scripts/proof_mutation_check.mjs --list     # describe, change nothing
//   node scripts/proof_mutation_check.mjs --only C1-self-join
//
// Requires: local Supabase running (Docker). REFUSES to run against any
// database that is not on localhost.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import {
  deriveAutomaticRlsMutations,
  evaluateMutationClaimCoverage,
  mutationCoversClaim,
} from "./proof_mutation_inventory.mjs";
import {
  assessPlantedSubject,
  assessSubjectAfterProof,
} from "./proof_plant_verification.mjs";
import {
  applySourceMutation,
  restoreSourceMutation,
  snapshotSourceMutation,
} from "./proof_source_mutation.mjs";
import { loadMutationCatalog, loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const { loadEnvConfig } = nextEnv;
loadEnvConfig(CONFIG.rootDir);
const require = createRequire(import.meta.url);

const CONFIG_TOML = CONFIG.repository.supabaseConfig;
const TRACE_DIR = CONFIG.artifacts.traces;
const SCHEMA_PATH = CONFIG.artifacts.schema;
const MUTATION_POLICY_PATH = CONFIG.policies.mutation;
const MUTATION_ARTIFACT_DIR = CONFIG.artifacts.mutations;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const MUTATIONS = await loadMutationCatalog(CONFIG);

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

function readProjectId() {
  if (!fs.existsSync(CONFIG_TOML)) {
    console.error(`[mutation] ${CONFIG_TOML} not found`);
    process.exit(2);
  }
  const id = fs
    .readFileSync(CONFIG_TOML, "utf8")
    .match(/^project_id\s*=\s*"(.*)"$/m)?.[1];
  if (!id) {
    console.error(`[mutation] could not read project_id from ${CONFIG_TOML}`);
    process.exit(2);
  }
  return id;
}

/**
 * Refuse to touch anything that is not unmistakably a local dev database.
 * This script's whole job is to break security policies on purpose; pointing it
 * at a shared or hosted database would be catastrophic, so the check is a hard
 * abort rather than a warning.
 */
function assertLocalDatabase() {
  const res = spawnSync(
    "pnpm",
    ["exec", "supabase", "status", "--output", "env"],
    {
      encoding: "utf8",
    },
  );
  if (res.status !== 0) {
    console.error(
      "[mutation] could not read `supabase status`; is local Supabase running?\n" +
        "  hint: bash scripts/ensure-supabase.sh",
    );
    process.exit(2);
  }
  const dbUrl = res.stdout.match(/^DB_URL="?([^"\n]+)"?$/m)?.[1] ?? "";
  const isLocal = /@(127\.0\.0\.1|localhost|\[::1\]):/.test(dbUrl);
  if (!isLocal) {
    console.error(
      `[mutation] REFUSING to run: DB_URL is not local (${dbUrl || "<unreadable>"}).\n` +
        "  This script intentionally disables security policies and must only ever\n" +
        "  target a local throwaway database.",
    );
    process.exit(2);
  }
  return dbUrl;
}

function runSql(container, sql) {
  const res = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
    ],
    { input: sql, encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(
      `SQL failed (exit ${res.status}):\n${sql}\n${res.stderr || res.stdout}`,
    );
  }
  return res.stdout;
}

/** Run a query and return its single scalar result as a trimmed string. */
function queryScalar(container, sql) {
  const res = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`query failed:\n${sql}\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Snapshot / restore
//
// Each subject kind knows how to read its own current definition and how to put
// that exact definition back. `restore` is therefore always derived from what was
// really there a moment ago, never from an assumption baked into this file.
// ---------------------------------------------------------------------------

const SUBJECTS = {
  sourceFile: {
    describe: (s) => `source file ${s.file}`,
    snapshot: (_container, s) => snapshotSourceMutation(s),
    restore: (s, snapshot) => {
      restoreSourceMutation(s, snapshot);
    },
  },

  trigger: {
    describe: (s) => `trigger ${s.name} on ${s.table}`,
    snapshot: (container, s) =>
      queryScalar(
        container,
        `SELECT coalesce(pg_get_triggerdef(oid), '') FROM pg_trigger
         WHERE tgrelid = ${quoteLiteral(s.table)}::regclass
           AND tgname = ${quoteLiteral(s.name)} AND NOT tgisinternal`,
      ),
    restore: (s, snapshot) =>
      `DROP TRIGGER IF EXISTS ${s.name} ON ${s.table};` +
      (snapshot ? `\n${snapshot};` : ""),
  },

  policy: {
    describe: (s) => `policy "${s.name}" on ${s.table}`,
    snapshot: (container, s) => {
      const raw = queryScalar(
        container,
        `SELECT coalesce(pg_get_expr(polqual, polrelid), '') || '~~~' ||
                coalesce(pg_get_expr(polwithcheck, polrelid), '')
         FROM pg_policy
         WHERE polrelid = ${quoteLiteral(s.table)}::regclass
           AND polname = ${quoteLiteral(s.name)}`,
      );
      // A policy with neither USING nor WITH CHECK cannot be reconstructed.
      return raw === "~~~" ? "" : raw;
    },
    restore: (s, snapshot) => {
      const [using, check] = snapshot.split("~~~");
      const clauses = [
        using ? `USING (${using})` : "",
        check ? `WITH CHECK (${check})` : "",
      ].filter(Boolean);
      return `ALTER POLICY "${s.name}" ON ${s.table} ${clauses.join(" ")};`;
    },
  },

  rowLevelSecurity: {
    describe: (s) => `row-level security on ${s.table}`,
    snapshot: (container, s) =>
      queryScalar(
        container,
        `SELECT relrowsecurity::text || '~~~' || relforcerowsecurity::text
         FROM pg_class
         WHERE oid = ${quoteLiteral(s.table)}::regclass`,
      ),
    restore: (s, snapshot) => {
      const [enabled, forced] = snapshot.split("~~~");
      return (
        `ALTER TABLE ${s.table} ${enabled === "true" ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;\n` +
        `ALTER TABLE ${s.table} ${forced === "true" ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`
      );
    },
  },

  tablePrivilege: {
    describe: (s) => `${s.privilege} on ${s.table} for ${s.role}`,
    snapshot: (container, s) =>
      queryScalar(
        container,
        `SELECT has_table_privilege(${quoteLiteral(s.role)}, ${quoteLiteral(s.table)}, ${quoteLiteral(s.privilege)})`,
      ),
    restore: (s, snapshot) =>
      snapshot === "t"
        ? `GRANT ${s.privilege} ON ${s.table} TO ${s.role};`
        : `REVOKE ${s.privilege} ON ${s.table} FROM ${s.role};`,
  },

  functionPrivilege: {
    describe: (s) => `${s.privilege} on ${s.signature} for ${s.role}`,
    snapshot: (container, s) =>
      queryScalar(
        container,
        `SELECT has_function_privilege(${quoteLiteral(s.role)}, ${quoteLiteral(s.signature)}, ${quoteLiteral(s.privilege)})`,
      ),
    restore: (s, snapshot) =>
      snapshot === "t"
        ? `GRANT ${s.privilege} ON FUNCTION ${s.signature} TO ${s.role};`
        : `REVOKE ${s.privilege} ON FUNCTION ${s.signature} FROM ${s.role};`,
  },
};

function subjectHandler(subject) {
  const handler = SUBJECTS[subject.kind];
  if (!handler) throw new Error(`unknown subject kind "${subject.kind}"`);
  return handler;
}

function isSourceMutation(mutation) {
  return mutation.subject?.kind === "sourceFile";
}

function applyMutation(container, mutation, snapshot) {
  if (!isSourceMutation(mutation)) {
    runSql(container, mutation.apply);
    return;
  }

  applySourceMutation(mutation.id, mutation.subject, snapshot);
}

function restoreMutation(container, mutation, handler, snapshot) {
  if (isSourceMutation(mutation)) {
    handler.restore(mutation.subject, snapshot);
    const after = handler.snapshot(container, mutation.subject);
    if (after !== snapshot) {
      throw new Error(
        `${handler.describe(mutation.subject)} did not return to its exact original contents`,
      );
    }
    return;
  }

  if (mutation.cleanup) runSql(container, mutation.cleanup);
  runSql(container, handler.restore(mutation.subject, snapshot));

  const after = handler.snapshot(container, mutation.subject);
  if (after !== snapshot) {
    throw new Error(
      `${handler.describe(mutation.subject)} did not return to its original state\n` +
        `  before: ${snapshot}\n  after:  ${after}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Spec coverage
//
// The harness is only as honest as its own inventory: a proof nobody planted a
// defect against is a proof nobody has seen fail.
// ---------------------------------------------------------------------------

const PROOFS_DIR = CONFIG.roots.proofs;

function listSpecs() {
  if (!fs.existsSync(PROOFS_DIR)) return [];
  return fs
    .readdirSync(PROOFS_DIR)
    .filter((f) => f.endsWith(".proof.ts"))
    .map((f) => path.join(PROOFS_DIR, f))
    .sort();
}

function readMutationPolicy() {
  try {
    const policy = JSON.parse(fs.readFileSync(MUTATION_POLICY_PATH, "utf8"));
    if (policy.schemaVersion !== 1) {
      return {
        policy: { acceptedClaims: [] },
        problems: [
          `${MUTATION_POLICY_PATH} has unsupported schemaVersion ${policy.schemaVersion ?? "<missing>"}; expected 1`,
        ],
      };
    }
    return { policy, problems: [] };
  } catch (error) {
    return {
      policy: { acceptedClaims: [] },
      problems: [
        `cannot read ${MUTATION_POLICY_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function buildMutationInventory() {
  const derived = deriveAutomaticRlsMutations({
    tracesDir: TRACE_DIR,
    schemaPath: SCHEMA_PATH,
    explicitMutations: MUTATIONS,
  });
  const mutations = [...MUTATIONS, ...derived.mutations];
  const ids = new Set();
  const problems = [...derived.problems];

  for (const mutation of mutations) {
    if (ids.has(mutation.id)) {
      problems.push(`duplicate mutation id "${mutation.id}"`);
    }
    ids.add(mutation.id);
  }

  const loadedPolicy = readMutationPolicy();
  const claimCoverage = evaluateMutationClaimCoverage({
    claims: derived.claims,
    evidence: derived.evidence,
    mutations,
    policy: loadedPolicy.policy,
  });
  problems.push(...loadedPolicy.problems, ...claimCoverage.problems);
  for (const claim of claimCoverage.uncoveredClaims) {
    problems.push(
      `${claim.spec} has no mutation or accepted policy entry for ${claim.kind}:${claim.target}:${claim.operation}`,
    );
  }

  const mutationsWithClaims = mutations.map((mutation) => ({
    ...mutation,
    resolvedClaims: derived.claims
      .filter((claim) => mutationCoversClaim(mutation, claim))
      .map((claim) => ({
        kind: claim.kind,
        target: claim.target,
        operation: claim.operation,
      })),
  }));

  return {
    mutations: mutationsWithClaims,
    problems,
    claims: derived.claims,
    acceptedClaims: claimCoverage.acceptedClaims,
    uncoveredClaims: claimCoverage.uncoveredClaims,
    uncoveredActionClaims: claimCoverage.uncoveredClaims.filter((claim) =>
      /^[A-Za-z][\w-]*:[A-Za-z][\w-]*$/.test(claim.target),
    ),
  };
}

/**
 * Returns inventory problems plus mutations pointing at specs that no longer
 * exist. Claim-level mutation/policy coverage is computed in buildMutationInventory.
 */
function checkSpecCoverage(mutations, derivationProblems = []) {
  const specs = new Set(listSpecs());
  const problems = [...derivationProblems];

  for (const ref of new Set(mutations.map((mutation) => mutation.spec))) {
    if (!specs.has(ref)) {
      problems.push(
        `${ref} is referenced by a mutation but does not exist — the reference is stale.`,
      );
    }
  }
  return problems;
}

function printUncoveredActionClaims(claims) {
  if (claims.length === 0) return;
  console.warn(
    `\n[mutation] ${claims.length} action-layer claim(s) have passing proof evidence but no mutation known to reach them:`,
  );
  for (const claim of claims) {
    console.warn(`  - ${claim.kind}:${claim.target} (${claim.spec})`);
  }
  console.warn(
    "  These proofs are useful, but they have not independently demonstrated that their action assertion can turn red.",
  );
}

// ---------------------------------------------------------------------------
// Proof execution
// ---------------------------------------------------------------------------

const DEV_SERVER_URL = process.env.DEV_SERVER ?? "http://localhost:3000";
const DEV_SERVER_TIMEOUT_MS = 120_000;

async function serverIsReachable(url) {
  try {
    await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function proofServerIssue(url) {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) {
    return "API_SECRET_KEY is not set after loading .env.local";
  }

  try {
    const response = await fetch(new URL("/api/proof/health", url), {
      headers: {
        "x-proof-secret": secret,
        ...(process.env.NEXT_PUBLIC_SUPABASE_URL
          ? {
              "x-proof-supabase-url": process.env.NEXT_PUBLIC_SUPABASE_URL,
            }
          : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      // An HTML/empty response means this is not a compatible proof server.
    }
    if (response.ok) {
      if (body?.protocolVersion !== 1) {
        return (
          `incompatible proof health protocol (expected 1, received ` +
          `${body?.protocolVersion ?? "<missing>"})`
        );
      }
      return null;
    }
    let detail = `status ${response.status}`;
    if (body) {
      detail = body.suggestion ?? body.error ?? detail;
    }
    return detail;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function signalProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  // `pnpm dev` launches Next as a child. On Unix, killing only pnpm can leave
  // Next alive and make the next CI job fail on the port or `.next/dev/lock`.
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the cross-platform single-process signal.
    }
  }
  child.kill(signal);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    child.once("exit", onExit);
    // Close the tiny race between the first check and installing the listener.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

/**
 * Start one Next.js server for the whole mutation run.
 *
 * Every mutation still gets its own isolated Playwright process and its own
 * planted database defect. The only thing shared is the immutable app server,
 * which used to be compiled and started again for every mutation. Locally, an
 * already-running server is reused and never stopped by this script.
 */
async function sharedDevServer() {
  if (await serverIsReachable(DEV_SERVER_URL)) {
    const issue = await proofServerIssue(DEV_SERVER_URL);
    if (issue) {
      throw new Error(
        `[PROOF_FAIL] proof_server_stale: the process at ${DEV_SERVER_URL} failed /api/proof/health: ${issue}. ` +
          "Restart it after updating .env.local; mutation testing will not reuse an unverified server.",
      );
    }
    console.log(
      `[mutation] reusing existing dev server at ${DEV_SERVER_URL}\n`,
    );
    return { stop: async () => {} };
  }

  const url = new URL(DEV_SERVER_URL);
  const output = [];
  const child = spawn("pnpm", ["dev"], {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...(url.port ? { PORT: url.port } : {}),
      PROOF_MODE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const remember = (chunk) => {
    output.push(chunk.toString());
    // Enough context for startup failures without retaining an entire CI log.
    if (output.length > 200) output.shift();
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  child.once("error", (error) => remember(`spawn error: ${error.message}\n`));

  const deadline = Date.now() + DEV_SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `shared dev server exited before becoming ready:\n${output.join("")}`,
      );
    }
    if (await serverIsReachable(DEV_SERVER_URL)) {
      const issue = await proofServerIssue(DEV_SERVER_URL);
      if (issue) {
        signalProcessTree(child, "SIGTERM");
        await waitForExit(child, 5_000);
        throw new Error(
          `shared dev server failed /api/proof/health after startup: ${issue}`,
        );
      }
      console.log(`[mutation] shared dev server ready at ${DEV_SERVER_URL}\n`);
      return {
        stop: async () => {
          signalProcessTree(child, "SIGTERM");
          if (!(await waitForExit(child, 5_000))) {
            signalProcessTree(child, "SIGKILL");
            await waitForExit(child, 2_000);
          }
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  signalProcessTree(child, "SIGTERM");
  await waitForExit(child, 5_000);
  throw new Error(
    `shared dev server did not become ready at ${DEV_SERVER_URL} within ${DEV_SERVER_TIMEOUT_MS / 1_000}s:\n` +
      output.join(""),
  );
}

function snapshotTraceFiles() {
  const snapshot = new Map();
  if (!fs.existsSync(TRACE_DIR)) return snapshot;
  for (const entry of fs.readdirSync(TRACE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(TRACE_DIR, entry.name);
    snapshot.set(entry.name, fs.readFileSync(file, "utf8"));
  }
  return snapshot;
}

function changedTraceFiles(before) {
  if (!fs.existsSync(TRACE_DIR)) return [];
  const changed = [];
  for (const entry of fs.readdirSync(TRACE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(TRACE_DIR, entry.name);
    const content = fs.readFileSync(file, "utf8");
    if (before.get(entry.name) === content) continue;
    const trace = JSON.parse(content);
    // Aggregated mission artifacts also live here, but mutation Playwright runs
    // only write per-proof traces with a steps array.
    if (trace && Array.isArray(trace.steps)) {
      changed.push({ name: entry.name, content, trace });
    }
  }
  return changed;
}

function failedClaimKeys(changed) {
  const keys = new Set();
  for (const item of changed) {
    for (const step of item.trace.steps ?? []) {
      for (const assertion of step.assertions ?? []) {
        if (
          assertion.passed !== false ||
          assertion.status === "skipped" ||
          assertion.status === "incomplete" ||
          typeof assertion.operation !== "string"
        ) {
          continue;
        }
        keys.add(
          `${assertion.kind}\0${assertion.target}\0${assertion.operation}`,
        );
      }
    }
  }
  return keys;
}

function archiveMutationTraces(mutation, before, playwrightFailed, reasonOk) {
  const changed = changedTraceFiles(before);
  if (changed.length === 0) {
    throw new Error(
      `mutation ${mutation.id} produced no fresh trace artifact; a non-zero Playwright exit without trace evidence cannot demonstrate detection`,
    );
  }

  const destination = path.join(MUTATION_ARTIFACT_DIR, mutation.id);
  fs.mkdirSync(destination, { recursive: true });
  const traceTurnedRed = changed.some((item) => item.trace.passed === false);
  const requiredClaims = Array.isArray(mutation.claims)
    ? mutation.claims
    : (mutation.resolvedClaims ?? []);
  const redClaims = failedClaimKeys(changed);
  const claimsTurnedRed = requiredClaims.every((claim) =>
    redClaims.has(`${claim.kind}\0${claim.target}\0${claim.operation}`),
  );
  const detected = playwrightFailed && traceTurnedRed && claimsTurnedRed;

  for (const item of changed) {
    if (
      item.trace.mutation?.id !== mutation.id ||
      item.trace.mutation?.planted !== true
    ) {
      throw new Error(
        `trace ${item.name} is missing mutation provenance for ${mutation.id}`,
      );
    }
    fs.writeFileSync(path.join(destination, item.name), item.content, "utf8");
  }

  fs.writeFileSync(
    path.join(destination, "mutation.json"),
    JSON.stringify(
      {
        id: mutation.id,
        finding: mutation.finding,
        breaks: mutation.breaks,
        spec: mutation.spec,
        claims: requiredClaims,
        detected,
        claimsTurnedRed,
        reasonMatched: reasonOk,
        traces: changed.map((item) => item.name),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    names: changed.map((item) => item.name),
    detected,
    traceTurnedRed,
    claimsTurnedRed,
  };
}

function writeMutationSummary(results, inventory) {
  fs.mkdirSync(MUTATION_ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(MUTATION_ARTIFACT_DIR, "summary.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mutations: results,
        claims: inventory.claims,
        acceptedClaims: inventory.acceptedClaims,
        uncoveredClaims: inventory.uncoveredClaims,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runProof(spec, mutationId) {
  return new Promise((resolve) => {
    const playwrightCli = require.resolve("@playwright/test/cli");
    const child = spawn(
      process.execPath,
      [
        playwrightCli,
        "test",
        "--project=proofs",
        spec,
        "--reporter=line",
        // A planted defect is expected to turn the proof red. Retrying that
        // deliberate failure only reruns the same proof against the same
        // broken database, multiplying mutation time without adding evidence.
        "--retries=0",
        "--workers=1",
      ],
      {
        env: {
          ...process.env,
          CI: process.env.CI ?? "",
          PLAYWRIGHT_REUSE_EXISTING_SERVER: "true",
          PROOF_MUTATION_ID: mutationId,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    child.on("error", (err) => resolve({ code: 1, output: String(err) }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { inventory: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--inventory") args.inventory = true;
    else if (v === "--list") args.list = true;
    else if (v === "--only") args.only = argv[++i];
    else if (v === "--help" || v === "-h") args.help = true;
    else {
      console.error(`[mutation] unknown flag: ${v}`);
      process.exit(2);
    }
  }
  return args;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inventory = buildMutationInventory();
  const mutations = inventory.mutations;

  if (args.help) {
    console.log(`Usage: node scripts/proof_mutation_check.mjs [--inventory] [--list] [--only <id>]

Re-opens each known vulnerability, asserts the matching proof fails, reverts.
Exits non-zero if any proof failed to notice its vulnerability.`);
    return;
  }

  if (args.inventory) {
    const problems = checkSpecCoverage(mutations, inventory.problems);
    for (const problem of problems) {
      console.error(`[mutation] ${problem}`);
    }
    if (problems.length > 0) {
      console.error(
        `\n[PROOF_FAIL] mutation_inventory: ${problems.length} inventory problem(s) found.`,
      );
      process.exit(1);
    }
    printUncoveredActionClaims(inventory.uncoveredActionClaims);
    console.log(
      `[mutation] inventory complete: ${mutations.length} mutation(s), ` +
        `${mutations.filter((mutation) => mutation.automatic).length} automatic RLS mutation(s), ` +
        `${inventory.claims.length} primary claim(s), ` +
        `${inventory.acceptedClaims.length} accepted claim exception(s).`,
    );
    return;
  }

  if (args.list) {
    console.log("Mutations (each must be detected by its proof):\n");
    for (const m of mutations) {
      console.log(
        `  ${m.id}  [${m.finding}]${m.automatic ? " (automatic)" : ""}`,
      );
      console.log(`    breaks: ${m.breaks}`);
      console.log(`    caught by: ${m.spec}`);
      console.log(
        `    restores: ${subjectHandler(m.subject).describe(m.subject)}\n`,
      );
    }
    console.log("Claims deliberately left unmutated:\n");
    for (const claim of inventory.acceptedClaims) {
      console.log(
        `  ${claim.kind}:${claim.target}:${claim.operation} (${claim.spec})`,
      );
    }
    const problems = checkSpecCoverage(mutations, inventory.problems);
    for (const p of problems) console.log(`  ! ${p}`);
    if (problems.length > 0) process.exit(1);
    printUncoveredActionClaims(inventory.uncoveredActionClaims);
    console.log(
      `Inventory complete: ${mutations.length} mutation(s), including ` +
        `${mutations.filter((mutation) => mutation.automatic).length} automatic RLS mutation(s).`,
    );
    return;
  }

  // Checked before touching the database: an incomplete inventory is a finding
  // in its own right, and it costs nothing to report up front.
  const coverageProblems = checkSpecCoverage(mutations, inventory.problems);
  for (const p of coverageProblems) {
    console.error(`[mutation] ${p}`);
  }
  printUncoveredActionClaims(inventory.uncoveredActionClaims);

  const requested = args.only
    ? mutations.filter((m) => m.id === args.only)
    : mutations;
  // Keep source mutations last so database mutations still share one server.
  // Each source mutation gets a fresh server started after the file is patched.
  const selected = [
    ...requested.filter((mutation) => !isSourceMutation(mutation)),
    ...requested.filter((mutation) => isSourceMutation(mutation)),
  ];

  if (selected.length === 0) {
    console.error(
      `[mutation] no mutation with id "${args.only}"; run --list to see them`,
    );
    process.exit(2);
  }

  // Mutation artifacts describe exactly one run. Keeping an earlier run here
  // would let stale planted failures masquerade as evidence from this one.
  fs.rmSync(MUTATION_ARTIFACT_DIR, { recursive: true, force: true });

  assertLocalDatabase();
  const container = `supabase_db_${readProjectId()}`;

  console.log(
    `[mutation] verifying that ${selected.length} planted defect(s) are detected by the proof suite`,
  );
  console.log(`[mutation] database container: ${container}\n`);

  const results = [];
  let devServer = null;

  try {
    // Start (or adopt) the shared server BEFORE the first defect is planted.
    // Consumer `pnpm dev` bootstrap hooks — migration re-application, seeding,
    // schema reconciliation — must run against the healthy database, not
    // inside the first mutation's window, where a wholesale re-GRANT would
    // silently un-plant it.
    if (selected.some((mutation) => !isSourceMutation(mutation))) {
      devServer = await sharedDevServer();
    }

    for (const m of selected) {
      console.log(`── ${m.id} ──────────────────────────────────────────`);
      console.log(`   planting: ${m.breaks}`);

      const handler = subjectHandler(m.subject);
      let snapshot = null;
      let applied = false;
      let sourceServer = null;
      try {
        snapshot = handler.snapshot(container, m.subject);
        if (snapshot === "") {
          throw new Error(
            `nothing to snapshot for ${handler.describe(m.subject)} — the object this ` +
              `mutation depends on does not exist, so the mutation would prove nothing`,
          );
        }

        applyMutation(container, m, snapshot);
        applied = true;

        // A defect that is not demonstrably live proves nothing: running the
        // proof anyway would blame the proof ("MISSED") for a plant that never
        // happened. Read the subject back and refuse to continue on mismatch.
        const plantedSnapshot = handler.snapshot(container, m.subject);
        const plantProblem = assessPlantedSubject({
          id: m.id,
          description: handler.describe(m.subject),
          before: snapshot,
          afterApply: plantedSnapshot,
          applyDoesNotChangeSubject: m.applyDoesNotChangeSubject === true,
        });
        if (plantProblem) throw new Error(plantProblem);

        if (isSourceMutation(m)) {
          if (devServer) {
            await devServer.stop();
            devServer = null;
          }
          sourceServer = await sharedDevServer();
        } else if (!devServer) {
          devServer = await sharedDevServer();
        }

        const tracesBefore = snapshotTraceFiles();
        const { code, output } = await runProof(m.spec, m.id);
        const playwrightFailed = code !== 0;

        // The defect must still be live now that the proof has finished. If
        // the subject reverted mid-run (issue #7: a re-applied migration
        // re-granting a revoked privilege), the proof's verdict — green or
        // red — says nothing about the proof, and archiving it as MISSED
        // would misdirect the operator toward a working proof.
        const afterProofSnapshot = handler.snapshot(container, m.subject);
        const liveProblem = assessSubjectAfterProof({
          id: m.id,
          description: handler.describe(m.subject),
          before: snapshot,
          afterApply: plantedSnapshot,
          afterProof: afterProofSnapshot,
          applyDoesNotChangeSubject: m.applyDoesNotChangeSubject === true,
        });
        if (liveProblem) throw new Error(liveProblem);

        // A proof can fail for the wrong reason (a crash, a timeout, a missing
        // browser). Where the reason matters — as with the deny-all mutation that
        // only a positive control can catch — require it in the output.
        const reasonOk =
          !m.expectFailureContains || output.includes(m.expectFailureContains);
        const archived = archiveMutationTraces(
          m,
          tracesBefore,
          playwrightFailed,
          reasonOk,
        );
        const detected = archived.detected;

        results.push({
          id: m.id,
          detected,
          reasonOk,
          spec: m.spec,
          expectedReason: m.expectFailureContains,
          traces: archived.names,
          traceTurnedRed: archived.traceTurnedRed,
          claimsTurnedRed: archived.claimsTurnedRed,
        });

        if (detected && reasonOk) {
          console.log(`   ✓ DETECTED — ${path.basename(m.spec)} turned red`);
          if (m.expectFailureContains) {
            console.log(
              `     (failed via ${m.expectFailureContains}, as required)`,
            );
          }
        } else if (detected && !reasonOk) {
          console.log(
            `   ✗ WRONG REASON — the proof failed, but not via "${m.expectFailureContains}".`,
          );
        } else if (!archived.claimsTurnedRed) {
          console.log(
            "   ✗ WRONG CLAIM — the proof failed, but the mutation's mapped claim did not turn red.",
          );
        } else {
          console.log(
            `   ✗ MISSED — the vulnerability is live and ${path.basename(m.spec)} still passed.`,
          );
        }
      } catch (err) {
        results.push({ id: m.id, error: String(err?.message ?? err) });
        console.log(`   ! ERROR — ${err?.message ?? err}`);
      } finally {
        let stopError = null;
        if (sourceServer) {
          try {
            await sourceServer.stop();
          } catch (error) {
            stopError = error;
          }
        }
        if (applied) {
          try {
            // Trust nothing: restore from the exact snapshot and read back.
            // Source mutations preserve dirty working-tree contents byte-for-byte;
            // database mutations preserve the live object's catalog definition.
            restoreMutation(container, m, handler, snapshot);
            console.log(
              `   reverted (${handler.describe(m.subject)} verified)\n`,
            );
          } catch (err) {
            const recovery = isSourceMutation(m)
              ? `Restore ${m.subject.file} before continuing.`
              : "Restore it with:\n    pnpm exec supabase db reset";
            console.error(
              `\n[mutation] FAILED TO REVERT "${m.id}". The local checkout is still vulnerable. ` +
                `${recovery}\n${err?.message ?? err}\n`,
            );
            process.exit(3);
          }
        }
        if (stopError) throw stopError;
      }
    }
  } finally {
    if (devServer) await devServer.stop();
  }

  writeMutationSummary(results, inventory);

  const missed = results.filter((r) => r.error || !r.detected || !r.reasonOk);
  // With --only the run is a deliberate subset, so an incomplete inventory is
  // reported but not fatal; a full run treats it as a failure.
  const inventoryFatal = !args.only && coverageProblems.length > 0;

  console.log("── summary ─────────────────────────────────────────");
  for (const r of results) {
    const verdict = r.error
      ? `ERROR (${r.error.split("\n")[0]})`
      : r.claimsTurnedRed === false
        ? "WRONG CLAIM"
        : !r.detected
          ? "MISSED"
          : !r.reasonOk
            ? `WRONG REASON (expected ${r.expectedReason})`
            : "detected";
    console.log(`   ${r.id}: ${verdict}`);
  }

  if (missed.length > 0) {
    console.error(
      `\n[PROOF_FAIL] mutation_check: ${missed.length} of ${results.length} planted defect(s) were not properly detected. ` +
        `The affected proofs cannot fail, so their green status means nothing.`,
    );
    process.exit(1);
  }

  if (inventoryFatal) {
    console.error(
      `\n[PROOF_FAIL] mutation_inventory: ${coverageProblems.length} proof spec(s) have never been shown to fail (listed above).`,
    );
    process.exit(1);
  }

  console.log(
    `\n[mutation] all ${results.length} planted defect(s) were detected; the proof suite can still fail.` +
      ` ${inventory.acceptedClaims.length} claim(s) are unmutated by declared choice.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[mutation] unexpected error: ${err?.stack ?? err}`);
    process.exit(2);
  });
}
