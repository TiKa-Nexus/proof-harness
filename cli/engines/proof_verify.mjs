#!/usr/bin/env node
// ---------------------------------------------------------------------------
// proof_verify.mjs
//
// The orchestrator CLI for the Proof SDK verification loop. Responsibilities:
//   1. Optionally run all Playwright proofs (e2e/proofs/*.proof.ts).
//   2. Read per-proof trace artifacts from `.proof/traces/*.json`.
//   3. Read `.proof/capabilities.json` + `.proof/schema.json` (produced by
//      scan/parse; considered current).
//   4. Resolve a mission manifest (flags or `.proof/current-mission.json`).
//   5. In manifest mode: validate via `validate-mission.ts` and write an
//      aggregated `.proof/traces/<missionId>.json`.
//   6. In no-manifest mode: print a human summary, exit 0 if all traces
//      passed.
//
// Emits structured `[PROOF_FAIL] <category>: <message>` lines on failure
// so CI log readers / consumers can route issues without parsing prose.
// Exit code: 0 on success, 1 on any failure.
//
// Flags (all optional):
//   --manifest <path>    Path to mission manifest JSON (default: resolve).
//   --mission <id>       Look up manifest at `.proof/missions/<id>.json`.
//   --no-run             Skip running Playwright; aggregate existing traces.
//   --traces-dir <path>  Trace directory (default: `.proof/traces`).
//   --help               Print usage.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import nextEnv from "@next/env";

import { validateMission } from "../../dist/node.js";
import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const { loadEnvConfig } = nextEnv;
loadEnvConfig(CONFIG.rootDir);

const TRACES_DIR_DEFAULT = CONFIG.artifacts.traces;
const MISSIONS_DIR = CONFIG.mission.directory;
const DEFAULT_MANIFEST = CONFIG.mission.current;
const CAPABILITIES_PATH = CONFIG.artifacts.capabilities;
const SCHEMA_PATH = CONFIG.artifacts.schema;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { noRun: false, help: false, tracesDir: TRACES_DIR_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--help" || v === "-h") args.help = true;
    else if (v === "--no-run") args.noRun = true;
    else if (v === "--mission") args.mission = argv[++i];
    else if (v === "--manifest") args.manifestPath = argv[++i];
    else if (v === "--traces-dir") args.tracesDir = argv[++i];
    else if (v.startsWith("--")) {
      console.error(`[proof:verify] unknown flag: ${v}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: pnpm proof:verify [flags]

Flags:
  --manifest <path>    Path to mission manifest JSON.
  --mission <id>       Look up manifest at .proof/missions/<id>.json.
  --no-run             Skip running proofs; aggregate existing traces.
  --traces-dir <path>  Trace directory (default: .proof/traces).
  --help               Print this help.

If no manifest is found, runs in no-manifest mode: verifies that every
trace passed but skips requirement validation.`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function resolveManifest(args) {
  if (args.manifestPath) {
    if (!fs.existsSync(args.manifestPath)) {
      console.error(
        `[proof:verify] --manifest path not found: ${args.manifestPath}`,
      );
      process.exit(2);
    }
    return {
      path: args.manifestPath,
      manifest: JSON.parse(fs.readFileSync(args.manifestPath, "utf8")),
    };
  }
  if (args.mission) {
    const p = path.join(MISSIONS_DIR, `${args.mission}.json`);
    if (!fs.existsSync(p)) {
      console.error(
        `[proof:verify] --mission ${args.mission} not found at ${p}`,
      );
      process.exit(2);
    }
    return { path: p, manifest: JSON.parse(fs.readFileSync(p, "utf8")) };
  }
  if (fs.existsSync(DEFAULT_MANIFEST)) {
    return {
      path: DEFAULT_MANIFEST,
      manifest: JSON.parse(fs.readFileSync(DEFAULT_MANIFEST, "utf8")),
    };
  }
  return { path: null, manifest: null };
}

// Well-known Playwright error fragment when a browser binary is missing.
// Matches e.g. `browserType.launch: Executable doesn't exist at /…/chromium`.
const PLAYWRIGHT_BROWSER_MISSING_RE = /Executable doesn'?t exist/i;

async function existingProofServerIssue() {
  const baseUrl = process.env.DEV_SERVER || "http://localhost:3000";
  const secret = process.env.API_SECRET_KEY;
  if (!secret) {
    return "API_SECRET_KEY is not set after loading .env.local; the proof runner cannot authenticate its dev-only routes.";
  }

  try {
    const response = await fetch(new URL("/api/proof/health", baseUrl), {
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
          `an existing server at ${baseUrl} uses an incompatible proof health protocol ` +
          `(expected 1, received ${body?.protocolVersion ?? "<missing>"})`
        );
      }
      return null;
    }
    let detail = `status ${response.status}`;
    if (body) {
      detail = body.suggestion ?? body.error ?? detail;
    }
    return `an existing server at ${baseUrl} failed the proof compatibility check: ${detail}`;
  } catch (error) {
    const cause = error?.cause;
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? cause.code
        : undefined;
    if (code === "ECONNREFUSED") return null;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return `an existing process at ${baseUrl} did not answer /api/proof/health within 5s`;
    }
    return `the proof server at ${baseUrl} could not be authenticated: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function runProofs(provenance) {
  console.log("[proof:verify] running Playwright proofs project…");
  return new Promise((resolve) => {
    const playwrightArgs = [
      "exec",
      "playwright",
      "test",
      "--project=proofs",
      "--reporter=list",
    ];
    if (process.env.CI) {
      // GitHub's standard runner has two CPUs. Database fixtures use unique
      // identifiers, so two workers shorten the green suite without sharing
      // browser contexts or weakening any assertion.
      playwrightArgs.push("--workers=2");
    }

    const child = spawn("pnpm", playwrightArgs, {
      env: {
        ...process.env,
        CI: process.env.CI ?? "",
        // Resolved once here and passed down so every trace in a run agrees
        // about the code it observed. Left unset rather than blank when
        // unknown, since the SDK reads absence as "ask git yourself".
        ...(provenance.commit ? { PROOF_COMMIT: provenance.commit } : {}),
        ...(provenance.dirty === undefined
          ? {}
          : { PROOF_DIRTY: String(provenance.dirty) }),
      },
    });
    // Tee both streams through to the user's terminal while capturing them, so
    // we can recognise the "Executable doesn't exist" failure after exit and
    // emit a structured, actionable hint. Playwright reports the missing-browser
    // error on STDOUT via its test reporter, so watching stderr alone silently
    // misses the most common first-run failure on a fresh machine.
    let captured = "";
    child.stdout.on("data", (chunk) => {
      captured += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      captured += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      console.error(
        `[proof:verify] failed to spawn playwright: ${err.message}`,
      );
      resolve(false);
    });
    child.on("close", (code) => {
      if (code !== 0 && PLAYWRIGHT_BROWSER_MISSING_RE.test(captured)) {
        console.error(
          `[PROOF_FAIL] playwright_browser_missing: expected Chromium binary to be installed; found it missing from the Playwright cache.\n` +
            `  hint: Run \`pnpm exec playwright install chromium\` once per machine, then retry.\n` +
            `  command: proof-harness verify`,
        );
      }
      resolve(code === 0);
    });
  });
}

function readArtifactsOrFail() {
  for (const p of [CAPABILITIES_PATH, SCHEMA_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(
        `[PROOF_FAIL] freshness: ${p} missing; run \`pnpm proof:scan && pnpm proof:parse\` first`,
      );
      process.exit(1);
    }
  }
  return {
    capabilities: JSON.parse(fs.readFileSync(CAPABILITIES_PATH, "utf8")),
    schema: JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")),
  };
}

function readTraces(tracesDir) {
  if (!fs.existsSync(tracesDir)) return [];
  const files = fs
    .readdirSync(tracesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(tracesDir, e.name))
    .sort();
  const traces = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
      // Skip aggregated mission traces; they have `proofs` not `steps`.
      if (parsed && Array.isArray(parsed.steps)) traces.push(parsed);
    } catch (err) {
      console.error(
        `[proof:verify] failed to parse trace ${f}: ${err.message}`,
      );
    }
  }
  return traces;
}

/**
 * Remove only the top-level JSON artifacts this runner owns.
 *
 * `--traces-dir` is user-controlled, so recursively deleting the supplied
 * directory would be unsafe. Per-proof and aggregated mission artifacts are
 * top-level JSON files; clearing those is sufficient to make a run fresh while
 * leaving unrelated files and nested directories untouched.
 */
function clearTraceArtifacts(tracesDir) {
  if (!fs.existsSync(tracesDir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(tracesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    fs.unlinkSync(path.join(tracesDir, entry.name));
    removed += 1;
  }
  return removed;
}

/**
 * Best-effort provenance for the run as a whole.
 *
 * A trace that says "tenant isolation holds" is only worth something if you can
 * tell WHICH code it was observed against. Every field is optional on purpose:
 * shallow clones, exported tarballs and non-git checkouts must still produce a
 * usable artifact, so a missing SHA degrades the evidence rather than failing
 * the run.
 */
function runProvenance() {
  const git = (args) => {
    const res = spawnSync("git", args, { encoding: "utf8" });
    if (res.status !== 0) return undefined;
    return res.stdout.trim() || undefined;
  };

  const commit = git(["rev-parse", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirtyOutput = git(["status", "--porcelain"]);

  return {
    commit,
    branch,
    // Whether the working tree had uncommitted changes when the proof ran. A
    // green proof from a dirty tree does not describe any reviewable commit.
    dirty: dirtyOutput === undefined ? undefined : dirtyOutput.length > 0,
    repository:
      process.env.GITHUB_REPOSITORY ?? git(["remote", "get-url", "origin"]),
    ci: Boolean(process.env.CI),
    runId: process.env.GITHUB_RUN_ID,
    command: `${path.basename(process.argv[0])} ${process.argv.slice(1).join(" ")}`,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

/**
 * Tally a trace's assertions by status. `status` is absent on traces written
 * before it existed, in which case it is derived from `passed` — the same rule
 * the SDK's normalizeAssertionStatus applies.
 */
export function countAssertionStatuses(trace) {
  const counts = { passed: 0, failed: 0, incomplete: 0, skipped: 0 };
  for (const step of trace.steps ?? []) {
    for (const assertion of step.assertions ?? []) {
      const status =
        assertion.status && assertion.status in counts
          ? assertion.status
          : assertion.passed
            ? "passed"
            : "failed";
      counts[status] += 1;
    }
  }
  return counts;
}

function writeAggregatedTrace(
  missionId,
  bundle,
  manifest,
  outcome,
  provenance,
) {
  const aggregated = {
    schemaVersion: 1,
    missionId,
    provenance,
    // Top-level mission verdict. Consumers read this single boolean to decide
    // pass/fail. True only when: (a) every proof spec in `bundle` passed AND
    // (b) mission validation against the manifest produced zero issues.
    passed: outcome.passed,
    aggregatedAt: new Date().toISOString(),
    manifestSummary: {
      missionTitle: manifest.missionTitle,
      capabilities_must_exist:
        manifest.requirements.capabilities_must_exist.length,
      schema_must_contain: manifest.requirements.schema_must_contain.length,
      trace_must_prove: manifest.requirements.trace_must_prove.length,
    },
    // Present (possibly empty) on success; populated on failure with every
    // [PROOF_FAIL] the validator emitted, in the same structured shape.
    issues: outcome.issues ?? [],
    // Which proof supplied the evidence for each trace requirement. Requirements
    // match against every assertion in the run, so without this the attribution
    // would be invisible and "0 issues" would have to be taken on faith.
    requirementEvidence: outcome.evidence ?? [],
    proofs: bundle.map((t) => ({
      proofId: t.proofId,
      missionId: t.missionId ?? null,
      specFile: t.specFile ?? null,
      specHash: t.specHash ?? null,
      passed: t.passed,
      durationMs: t.durationMs,
      stepCount: t.steps?.length ?? 0,
      assertionCount: (t.steps ?? []).reduce(
        (acc, s) => acc + (s.assertions?.length ?? 0),
        0,
      ),
      // Broken out because a boolean cannot express "we did not find out". A
      // proof can pass with a skipped direction, and a consumer that only reads
      // `passed` would have no way to see it — the skip would look like one
      // fewer assertion rather than one unanswered question.
      assertionStatus: countAssertionStatuses(t),
    })),
    traces: bundle,
  };
  const outPath = path.join(TRACES_DIR_DEFAULT, `${missionId}.json`);
  fs.mkdirSync(TRACES_DIR_DEFAULT, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(aggregated, null, 2) + "\n", "utf8");
  return outPath;
}

function printFailureSummary(issues) {
  for (const issue of issues) {
    console.error(`[PROOF_FAIL] ${issue.category}: ${issue.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Run-level failures that no amount of trace inspection can discover. These
  // are tracked separately from validator issues and folded into the verdict
  // below; a red Playwright run that happens to leave green traces behind must
  // never be reported as a pass.
  const runIssues = [];

  // Read git once for the whole run: the specs are told what they are running
  // against, and the aggregate reports the same thing. Asking twice invites a
  // `dirty` flag that flips between the run and the summary.
  const provenance = runProvenance();

  if (!args.noRun) {
    const serverIssue = await existingProofServerIssue();
    if (serverIssue) {
      runIssues.push({
        category: "proof_server_stale",
        message: `${serverIssue}. Restart the dev server after any .env.local change, then rerun proof:verify.`,
      });
    } else {
      const removed = clearTraceArtifacts(args.tracesDir);
      if (removed > 0) {
        console.log(
          `[proof:verify] cleared ${removed} previous trace artifact(s) before the run`,
        );
      }
      const ok = await runProofs(provenance);
      if (!ok) {
        // Continue to aggregation so users see trace-level issues too, but
        // remember that the run itself was red.
        runIssues.push({
          category: "proof_run",
          message:
            "one or more Playwright proofs failed; see test output above. " +
            "Note that a proof which crashes before writing its trace leaves no artifact at all, " +
            "so the trace summary below can look clean while the run was red.",
        });
      }
    }
  }

  const { capabilities, schema } = readArtifactsOrFail();
  const traces = readTraces(args.tracesDir);
  const resolved = resolveManifest(args);

  // Zero traces means zero evidence. Reporting that as "0 proof(s) passed" and
  // exiting 0 is the single most dangerous failure mode this tool can have: a
  // misconfigured runner, a bad --traces-dir, or a suite that died during
  // startup all produce an empty directory, and a green check on no evidence
  // gets trusted exactly like a green check on real evidence.
  // `--no-run` deliberately validates artifacts already on disk rather than
  // clearing them. Commit provenance catches cross-commit evidence; specFile
  // existence catches renamed/deleted proof files even on the same dirty commit.
  const orphaned = traces.filter(
    (t) =>
      typeof t.specFile === "string" &&
      t.specFile.length > 0 &&
      !fs.existsSync(path.resolve(t.specFile)),
  );
  if (orphaned.length > 0) {
    runIssues.push({
      category: "stale_trace",
      message:
        `${orphaned.length} trace(s) refer to proof specs that no longer exist: ` +
        orphaned.map((t) => `${t.proofId} → ${t.specFile}`).join(", ") +
        `. Deleted or renamed proofs cannot provide current evidence.`,
    });
  }

  if (provenance.commit) {
    const stale = traces.filter(
      (t) => typeof t.commit === "string" && t.commit !== provenance.commit,
    );
    if (stale.length > 0) {
      runIssues.push({
        category: "stale_trace",
        message:
          `${stale.length} trace(s) were recorded against a different commit than this run: ` +
          stale
            .map((t) => `${t.proofId} @ ${t.commit.slice(0, 12)}`)
            .join(", ") +
          `. Expected ${provenance.commit.slice(0, 12)}. ` +
          `Old evidence cannot speak for current code — clear the directory (rm -rf .proof/traces) and re-run.`,
      });
    }
  }

  if (traces.length === 0) {
    runIssues.push({
      category: "no_traces",
      message:
        `no trace artifacts found in ${args.tracesDir}; there is no evidence to verify. ` +
        `Expected at least one <proofId>.json written by trace.proof(). ` +
        `Check that e2e/proofs/*.proof.ts matched the Playwright "proofs" project and that the suite got past startup.`,
    });
  }

  for (const issue of runIssues) {
    console.error(`[PROOF_FAIL] ${issue.category}: ${issue.message}`);
  }

  // Always surface proofs whose own step failed, even in no-manifest mode.
  const failedProofs = traces.filter((t) => t.passed === false);
  for (const t of failedProofs) {
    for (const step of t.steps ?? []) {
      if (step.passed === false) {
        console.error(
          `[PROOF_FAIL] ${step.kind}: proof "${t.proofId}" step "${step.intent}" failed on target "${step.target}"${step.error ? `; error: ${step.error}` : ""}`,
        );
      }
    }
  }

  if (!resolved.manifest) {
    if (failedProofs.length > 0 || runIssues.length > 0) {
      const reasons = [];
      if (failedProofs.length > 0) {
        reasons.push(`${failedProofs.length}/${traces.length} proof(s) failed`);
      }
      for (const issue of runIssues) reasons.push(issue.category);
      console.error(
        `[proof:verify] no manifest (no-manifest mode); FAILED (${reasons.join(", ")})`,
      );
      process.exit(1);
    }
    console.log(
      `[proof:verify] no manifest (no-manifest mode); ${traces.length} proof(s) passed`,
    );
    return;
  }

  const manifest = resolved.manifest;
  console.log(
    `[proof:verify] validating against manifest ${manifest.missionId} (${resolved.path})`,
  );

  const result = validateMission({ manifest, capabilities, schema, traces });

  // Mission verdict = the Playwright run exited clean AND evidence exists AND
  // every proof in it passed AND zero manifest issues. We compute it up-front
  // so the aggregated trace is ALWAYS written (green or red) with a consistent
  // top-level `passed` for consumers to read.
  const missionPassed =
    result.ok && failedProofs.length === 0 && runIssues.length === 0;
  const aggregatedPath = writeAggregatedTrace(
    manifest.missionId,
    traces,
    manifest,
    {
      passed: missionPassed,
      issues: [...runIssues, ...(result.issues ?? [])],
      evidence: result.evidence ?? [],
    },
    provenance,
  );

  if (!result.ok) {
    printFailureSummary(result.issues);
  }

  if (!missionPassed) {
    const reasons = [];
    if (result.issues.length > 0)
      reasons.push(`${result.issues.length} manifest issue(s)`);
    if (failedProofs.length > 0)
      reasons.push(`${failedProofs.length} proof(s) failed`);
    for (const issue of runIssues) reasons.push(issue.category);
    console.error(
      `[proof:verify] mission ${result.missionId} FAILED (${reasons.join(", ")}); aggregated trace → ${aggregatedPath}`,
    );
    process.exit(1);
  }

  console.log(
    `[proof:verify] mission ${manifest.missionId} PASSED; aggregated trace → ${aggregatedPath}`,
  );
}

// Re-exported for compatibility. The implementation is the package's compiled
// validator; the CLI contains no second validation ruleset.
export { validateMission };

// Only run the CLI when executed directly, so importing this module for tests
// has no side effects.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[proof:verify] unexpected error: ${err?.stack ?? err}`);
    process.exit(2);
  });
}
