import { sourceHash } from "./source-hash";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { isProofKind } from "../shared/vocabulary";
import {
  normalizeAssertionRole,
  normalizeAssertionStatus,
  type TraceArtifact,
  type TraceAssertion,
} from "../shared/trace-types";

export const ASSERTION_HELPERS = [
  "assert.tenantIsolation",
  "assert.authorization",
  "assert.actionSucceeds",
  "assert.httpResponse",
] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;
const duration = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
export function isArtifactId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) &&
    v !== "." &&
    v !== ".."
  );
}
export function assertionPassed(a: TraceAssertion): boolean {
  return (
    a.passed === true &&
    normalizeAssertionStatus(a.status, a.passed) === "passed" &&
    normalizeAssertionRole(a.role) !== null
  );
}
export function traceShapeIssues(value: unknown): string[] {
  const issues: string[] = [];
  const bad = (where: string) => issues.push(`trace_shape: invalid ${where}`);
  if (!object(value)) return ["trace_shape: expected an object"];
  // Explicit legacy support: v1 and unversioned traces retain the original required fields.
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== 1 &&
    value.schemaVersion !== 2
  )
    bad("schemaVersion");
  if (!isArtifactId(value.proofId)) bad("proofId");
  if (value.missionId !== undefined && !isArtifactId(value.missionId))
    bad("missionId");
  if (!text(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)))
    bad("timestamp");
  if (!duration(value.durationMs)) bad("durationMs");
  if (typeof value.passed !== "boolean") bad("passed");
  if (
    value.mutation !== undefined &&
    (!object(value.mutation) ||
      !isArtifactId(value.mutation.id) ||
      value.mutation.planted !== true)
  )
    bad("mutation");
  for (const key of [
    "specFile",
    "specHash",
    "commit",
    "sourceHash",
    "executionId",
  ]) {
    if (value[key] !== undefined && !text(value[key])) bad(key);
  }
  if (value.dirty !== undefined && typeof value.dirty !== "boolean")
    bad("dirty");
  if (
    value.retry !== undefined &&
    (!Number.isInteger(value.retry) || Number(value.retry) < 0)
  )
    bad("retry");
  if (!Array.isArray(value.steps))
    return [...issues, "trace_shape: steps must be an array"];
  for (const [i, step] of value.steps.entries()) {
    if (!object(step)) {
      bad(`steps[${i}]`);
      continue;
    }
    if (
      !isProofKind(step.kind) ||
      !text(step.target) ||
      !text(step.intent) ||
      typeof step.observation !== "string" ||
      typeof step.passed !== "boolean" ||
      !duration(step.durationMs)
    )
      bad(`steps[${i}] fields`);
    if (value.passed === true && step.passed !== true)
      bad(`steps[${i}] contradicts proof verdict`);
    if (step.assertions === undefined) continue;
    if (!Array.isArray(step.assertions)) {
      bad(`steps[${i}].assertions`);
      continue;
    }
    for (const [j, a] of step.assertions.entries()) {
      const where = `steps[${i}].assertions[${j}]`;
      if (!object(a)) {
        bad(where);
        continue;
      }
      if (
        !isProofKind(a.kind) ||
        !text(a.target) ||
        typeof a.passed !== "boolean" ||
        normalizeAssertionRole(a.role) === null
      )
        bad(where);
      if (
        a.operation !== undefined &&
        !["select", "insert", "update", "delete", "invoke", "request"].includes(
          String(a.operation),
        )
      )
        bad(`${where}.operation`);
      if (
        a.emittedBy !== undefined &&
        !ASSERTION_HELPERS.includes(
          a.emittedBy as (typeof ASSERTION_HELPERS)[number],
        )
      )
        bad(`${where}.emittedBy`);
      if (
        a.status !== undefined &&
        (!["passed", "failed", "skipped", "incomplete"].includes(
          String(a.status),
        ) ||
          (a.status === "passed") !== a.passed)
      )
        bad(`${where}.status`);
      if (
        step.passed === true &&
        a.passed === false &&
        (a.status === undefined ||
          a.status === "failed" ||
          a.status === "incomplete")
      )
        bad(`${where} contradicts step verdict`);
    }
  }
  return issues;
}
export function decodeTrace(value: unknown): TraceArtifact {
  const issues = traceShapeIssues(value);
  if (issues.length) throw new Error(`[PROOF_FAIL] ${issues.join("; ")}`);
  return value as TraceArtifact;
}
export function decodeTraceBundle(values: readonly unknown[]): TraceArtifact[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const t = decodeTrace(value);
    if (seen.has(t.proofId))
      throw new Error(`[PROOF_FAIL] duplicate_proof_id: ${t.proofId}`);
    seen.add(t.proofId);
    return t;
  });
}
export function fileHash(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")
    .slice(0, 12);
}
export function readTraceDirectory(
  directory: string,
  {
    rootDir = process.cwd(),
    checkFreshness = true,
    excludedPaths = [] as readonly string[],
  } = {},
): TraceArtifact[] {
  if (!fs.existsSync(directory)) return [];
  const values: unknown[] = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let value: unknown;
    try {
      value = JSON.parse(
        fs.readFileSync(path.join(directory, entry.name), "utf8"),
      );
    } catch {
      throw new Error(`[PROOF_FAIL] invalid_json: ${entry.name}`);
    }
    if (
      object(value) &&
      value.schemaVersion === 1 &&
      isArtifactId(value.missionId) &&
      typeof value.passed === "boolean" &&
      Array.isArray(value.proofs) &&
      Array.isArray(value.traces) &&
      Array.isArray(value.issues) &&
      Array.isArray(value.requirementEvidence) &&
      value.steps === undefined
    )
      continue;
    values.push(value);
  }
  const traces = decodeTraceBundle(values);
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const commit = git.status === 0 ? git.stdout.trim() : undefined;
  const hash = checkFreshness
    ? sourceHash(rootDir, [...excludedPaths, directory])
    : undefined;
  for (const t of traces) {
    if (!checkFreshness || t.mutation) continue;
    if (!text(t.specFile) || !text(t.specHash))
      throw new Error(
        `[PROOF_FAIL] stale_trace: ${t.proofId} lacks spec provenance; rerun proofs`,
      );
    const file = path.resolve(rootDir, t.specFile);
    const relative = path.relative(rootDir, file);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !fs.existsSync(file) ||
      fileHash(file) !== t.specHash
    )
      throw new Error(
        `[PROOF_FAIL] stale_trace: ${t.proofId} spec changed or disappeared`,
      );
    if (hash && t.sourceHash !== hash)
      throw new Error(
        `[PROOF_FAIL] stale_trace: ${t.proofId} source contents changed or lack content identity`,
      );
    if (commit && t.commit !== commit)
      throw new Error(
        `[PROOF_FAIL] stale_trace: ${t.proofId} does not describe current commit`,
      );
  }
  return traces;
}
export function baselineAssertions(traces: readonly TraceArtifact[]) {
  return traces
    .filter((t) => t.passed && !t.mutation)
    .flatMap((t) =>
      t.steps
        .filter((s) => s.passed)
        .flatMap((s) =>
          (s.assertions ?? [])
            .filter(assertionPassed)
            .map((a) => ({ ...a, proofId: t.proofId, specFile: t.specFile })),
        ),
    );
}
