// Import External Packages
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "@playwright/test";
// Import Local Imports
import { codeProvenance } from "../server/code-provenance";
import {
  TRACE_ARTIFACT_SCHEMA_VERSION,
  normalizeAssertionStatus,
  type ProofOptions,
  type StepOptions,
  type StepResult,
  type TraceArtifact,
  type TraceAssertion,
  type TraceStep,
} from "../shared/trace-types";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// trace.proof / t.step
//
// A proof is a single run that answers "did we observe the intended
// behavior?" — one happy_path, one tenant_isolation check, one authorization
// probe, etc. Each step inside the proof records an intent, a kind (from the
// closed vocabulary), and what the agent actually observed. The resulting
// JSON artifact is written to `.proof/traces/<proofId>.json` and — in v1 —
// consumed by the mission-manifest validator, which groups proofs by their
// optional `missionId` and confirms every `trace_must_prove` requirement has
// a matching passing step across the group.
//
// Write path in v0.5 is hardcoded to `<cwd>/.proof/traces/`. Playwright runs
// from the repo root so this resolves to `<repo>/.proof/traces/`.
// ---------------------------------------------------------------------------

const TRACE_DIR_RELATIVE = [".proof", "traces"] as const;

/**
 * AsyncLocalStorage used to pipe `recordAssertion(...)` calls from inside
 * helper code (e.g. assert.tenantIsolation) to the step that wraps them,
 * without requiring every helper to take a recorder argument.
 */
const currentStepAssertions = new AsyncLocalStorage<TraceAssertion[]>();

/**
 * AsyncLocalStorage naming the `assert.*` helper currently executing. Set only
 * by `withAssertionProvenance`, which is deliberately NOT re-exported from the
 * package entry point (`./index`): the public `recordAssertion` strips any
 * caller-supplied `emittedBy`, so the only way an assertion carries helper
 * provenance is by actually being recorded while a helper runs. That is what
 * lets the mission validator treat `emittedBy` as evidence of origin rather
 * than as a string a spec happened to write.
 */
const currentHelperProvenance = new AsyncLocalStorage<string>();

/**
 * Run `fn` with helper provenance attached: every assertion recorded inside it
 * is stamped `emittedBy: helper`. Internal to the SDK — imported directly by
 * `./assert`, never exported from `./index`. Note that provenance spans the
 * whole helper call, including any user-supplied callbacks the helper invokes.
 */
export async function withAssertionProvenance<T>(
  helper: string,
  fn: () => Promise<T>,
): Promise<T> {
  return currentHelperProvenance.run(helper, fn);
}

/**
 * Run `fn` with helper provenance suspended. Helpers wrap every user-supplied
 * callback (`fixture.create`, `setup`, ...) in this, because those callbacks
 * are executor-authored code executing inside the helper's context — without
 * the suspension, a hostile fixture could call `recordAssertion` and receive
 * the helper's trusted stamp. Internal to the SDK, like its counterpart.
 */
export async function withoutAssertionProvenance<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return currentHelperProvenance.exit(fn);
}

/**
 * Called by `assert.*` helpers while running inside a step. If no step is
 * active (e.g. someone invokes a helper outside `trace.proof`), this is a
 * no-op so the helper still runs without crashing.
 *
 * Spec code may call this directly to record bespoke assertions; those are
 * recorded WITHOUT `emittedBy` (any supplied value is stripped), which marks
 * them as spec-authored claims rather than SDK-verified probes.
 */
export function recordAssertion(assertion: TraceAssertion): void {
  const bucket = currentStepAssertions.getStore();
  if (!bucket) return;
  // Provenance comes from the execution context, never from the caller: a
  // spec claiming `emittedBy: "assert.tenantIsolation"` on a hand-rolled
  // assertion must not be able to impersonate the helper.
  const { emittedBy: _claimed, ...rest } = assertion;
  const emittedBy = currentHelperProvenance.getStore();
  // Materialize `status` at write time rather than leaving consumers to derive
  // it: the artifact should say what it means without a decoder ring.
  bucket.push({
    ...rest,
    ...(emittedBy ? { emittedBy } : {}),
    status: normalizeAssertionStatus(assertion.status, assertion.passed),
  });
}

class TraceRecorderImpl {
  private readonly steps: TraceStep[] = [];

  constructor(private readonly proofId: string) {}

  getSteps(): readonly TraceStep[] {
    return this.steps;
  }

  async step<T extends StepResult | void>(
    opts: StepOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    const assertions: TraceAssertion[] = [];

    try {
      const result = await currentStepAssertions.run(
        assertions,
        async () => (await fn()) as T,
      );
      const durationMs = performance.now() - startedAt;

      const observation =
        result && typeof result === "object" && "observation" in result
          ? String((result as StepResult).observation ?? "")
          : "";

      this.steps.push({
        intent: opts.intent,
        kind: opts.kind,
        target: opts.target,
        actor: opts.actor,
        workspaceId: opts.workspaceId,
        observation,
        passed: true,
        durationMs: Math.round(durationMs),
        ...(assertions.length > 0 ? { assertions: [...assertions] } : {}),
      });

      return result;
    } catch (error) {
      const durationMs = performance.now() - startedAt;

      const message = error instanceof Error ? error.message : String(error);

      this.steps.push({
        intent: opts.intent,
        kind: opts.kind,
        target: opts.target,
        actor: opts.actor,
        workspaceId: opts.workspaceId,
        observation: "",
        passed: false,
        durationMs: Math.round(durationMs),
        error: message,
        ...(assertions.length > 0 ? { assertions: [...assertions] } : {}),
      });

      throw error;
    }
  }
}

const specHashCache = new Map<string, string>();

/**
 * Identify the spec file that is currently executing, plus a short content
 * hash, so a trace can be tied back to the exact code that produced it.
 *
 * Returns an empty object outside a Playwright run (or if the file can't be
 * read): provenance is evidence, and absent evidence must never be the reason
 * a proof fails to record.
 */
function specProvenance(): { specFile?: string; specHash?: string } {
  let absolutePath: string;
  try {
    absolutePath = test.info().file;
  } catch {
    return {};
  }
  if (!absolutePath) return {};

  const specFile = path.relative(process.cwd(), absolutePath);
  const cached = specHashCache.get(absolutePath);
  if (cached) return { specFile, specHash: cached };

  try {
    const contents = fs.readFileSync(absolutePath);
    const specHash = crypto
      .createHash("sha256")
      .update(contents)
      .digest("hex")
      .slice(0, 12);
    specHashCache.set(absolutePath, specHash);
    return { specFile, specHash };
  } catch {
    return { specFile };
  }
}

function writeArtifact(proofId: string, artifact: TraceArtifact): void {
  const traceDir = path.join(process.cwd(), ...TRACE_DIR_RELATIVE);
  fs.mkdirSync(traceDir, { recursive: true });
  const target = path.join(traceDir, `${proofId}.json`);
  fs.writeFileSync(target, JSON.stringify(artifact, null, 2), "utf8");
}

function normalizeOptions(arg: string | ProofOptions): ProofOptions {
  return typeof arg === "string" ? { proofId: arg } : arg;
}

function mutationProvenance(): TraceArtifact["mutation"] | undefined {
  const id = process.env.PROOF_MUTATION_ID?.trim();
  return id ? { id, planted: true } : undefined;
}

export const trace = {
  /**
   * Start a proof. The callback receives a recorder whose `.step()` method
   * wraps individual observations. When the callback resolves (or throws),
   * a JSON artifact is written to `.proof/traces/<proofId>.json`.
   *
   * The proof rethrows any thrown error so the Playwright test still fails —
   * the trace is written first so you can inspect the failure.
   *
   * @example
   * // Common v0.5 case: no mission attached
   * await trace.proof("auth-login-admin", async (t) => { ... });
   *
   * @example
   * // v1 case: proof belongs to a Botstrap mission
   * await trace.proof(
   *   { proofId: "auth-login-admin", missionId: "M-042" },
   *   async (t) => { ... },
   * );
   */
  async proof(
    arg: string | ProofOptions,
    fn: (t: TraceRecorderImpl) => Promise<void>,
  ): Promise<void> {
    const { proofId, missionId } = normalizeOptions(arg);
    const startedAt = performance.now();
    const timestamp = new Date().toISOString();
    const recorder = new TraceRecorderImpl(proofId);

    let proofError: unknown;
    try {
      await fn(recorder);
    } catch (error) {
      proofError = error;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const steps = recorder.getSteps();
    const passed = !proofError && steps.every((s) => s.passed);
    const mutation = mutationProvenance();

    const artifact: TraceArtifact = {
      schemaVersion: TRACE_ARTIFACT_SCHEMA_VERSION,
      proofId,
      ...(missionId ? { missionId } : {}),
      ...specProvenance(),
      ...codeProvenance(),
      ...(mutation ? { mutation } : {}),
      timestamp,
      durationMs,
      passed,
      steps: [...steps],
    };

    writeArtifact(proofId, artifact);

    if (proofError) throw proofError;
  },
};
