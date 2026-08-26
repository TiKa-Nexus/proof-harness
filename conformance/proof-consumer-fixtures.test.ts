import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateMission,
  type CapabilitiesArtifact,
  type SchemaArtifact,
} from "proof-harness/node";
import {
  normalizeAssertionRole,
  type MissionManifest,
  type TraceArtifact,
} from "proof-harness/shared";

type JsonObject = Record<string, unknown>;

interface CorpusCase {
  id: string;
  kind: string;
  path?: string;
  paths?: string[];
  expected: {
    classification: string;
    missionValidation?: "pass" | "fail";
    passed?: boolean;
    issueCategories?: string[];
    mutationId?: string;
    detected?: boolean;
    error?: string;
  };
}

interface Corpus {
  schemaVersion: number;
  sharedInputs: {
    manifest: string;
    capabilities: string;
    schema: string;
  };
  cases: CorpusCase[];
}

const ROOT = path.join(process.cwd(), "proof-consumer-fixtures");

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
  );
}

function classifyEvidenceArtifact(
  value: unknown,
): "trace" | "mission_aggregate" | "reject" {
  if (!isObject(value)) return "reject";
  if (
    value.schemaVersion === 1 &&
    typeof value.missionId === "string" &&
    typeof value.passed === "boolean" &&
    Array.isArray(value.proofs) &&
    Array.isArray(value.traces) &&
    Array.isArray(value.issues) &&
    Array.isArray(value.requirementEvidence)
  ) {
    return "mission_aggregate";
  }
  if (
    value.schemaVersion === 2 &&
    typeof value.proofId === "string" &&
    value.proofId.length > 0 &&
    isIsoTimestamp(value.timestamp) &&
    typeof value.durationMs === "number" &&
    value.durationMs >= 0 &&
    typeof value.passed === "boolean" &&
    Array.isArray(value.steps)
  ) {
    return "trace";
  }
  return "reject";
}

function issueCategories(
  issues: ReadonlyArray<{ category: string }>,
): string[] {
  return [...new Set(issues.map((issue) => issue.category))].sort();
}

const corpus = readJson<Corpus>("corpus.json");
const manifest = readJson<MissionManifest>(corpus.sharedInputs.manifest);
const capabilities = readJson<CapabilitiesArtifact>(
  corpus.sharedInputs.capabilities,
);
const schema = readJson<SchemaArtifact>(corpus.sharedInputs.schema);
const byId = new Map(corpus.cases.map((entry) => [entry.id, entry]));

function caseById(id: string): CorpusCase {
  const fixture = byId.get(id);
  if (!fixture) throw new Error(`missing corpus case ${id}`);
  return fixture;
}

describe("published Proof consumer conformance corpus", () => {
  it("contains every required ingestion case", () => {
    expect(corpus.schemaVersion).toBe(1);
    expect([...byId.keys()].sort()).toEqual(
      [
        "baseline-failing",
        "baseline-passing",
        "duplicate-proof-id",
        "malformed-json",
        "malformed-manifest",
        "malformed-trace-shape",
        "mission-aggregate-failing",
        "mission-aggregate-passing",
        "mutation-directory",
      ].sort(),
    );
  });

  it.each(["baseline-passing", "baseline-failing"])(
    "grades %s with the canonical validator",
    (id) => {
      const fixture = caseById(id);
      const trace = readJson<TraceArtifact>(fixture.path!);
      expect(classifyEvidenceArtifact(trace)).toBe(
        fixture.expected.classification,
      );
      const result = validateMission({
        manifest,
        capabilities,
        schema,
        traces: [trace],
      });
      expect(result.ok).toBe(fixture.expected.missionValidation === "pass");
      expect(issueCategories(result.issues)).toEqual(
        [...(fixture.expected.issueCategories ?? [])].sort(),
      );
    },
  );

  it.each(["mission-aggregate-passing", "mission-aggregate-failing"])(
    "keeps %s distinct from per-spec traces",
    (id) => {
      const fixture = caseById(id);
      const aggregate = readJson<{
        passed: boolean;
        traces: TraceArtifact[];
        issues: Array<{ category: string }>;
        requirementEvidence: Array<{
          kind: string;
          target: string;
          role: string;
          satisfied: boolean;
          proofId?: string;
          specFile?: string;
        }>;
      }>(fixture.path!);
      expect(classifyEvidenceArtifact(aggregate)).toBe("mission_aggregate");
      expect(aggregate.passed).toBe(fixture.expected.passed);

      const result = validateMission({
        manifest,
        capabilities,
        schema,
        traces: aggregate.traces,
      });
      expect(aggregate.passed).toBe(
        result.ok && aggregate.traces.every((trace) => trace.passed),
      );
      expect(aggregate.issues).toEqual(result.issues);
      expect(aggregate.requirementEvidence).toEqual(result.evidence);
      expect(issueCategories(aggregate.issues)).toEqual(
        [...(fixture.expected.issueCategories ?? [])].sort(),
      );

      for (const evidence of aggregate.requirementEvidence) {
        if (!evidence.satisfied) continue;
        expect(
          aggregate.traces.some(
            (trace) =>
              trace.proofId === evidence.proofId &&
              (evidence.specFile === undefined ||
                trace.specFile === evidence.specFile) &&
              trace.steps.some((step) =>
                (step.assertions ?? []).some(
                  (assertion) =>
                    assertion.kind === evidence.kind &&
                    assertion.target === evidence.target &&
                    assertion.passed === true &&
                    normalizeAssertionRole(assertion.role) === evidence.role,
                ),
              ),
          ),
        ).toBe(true);
      }
    },
  );

  it("preserves mutation identity despite a baseline filename collision", () => {
    const fixture = caseById("mutation-directory");
    const descriptor = readJson<{
      id: string;
      detected: boolean;
      traces: string[];
    }>(`${fixture.path!}/mutation.json`);
    const baseline = readJson<TraceArtifact>(
      caseById("baseline-passing").path!,
    );
    expect(descriptor.id).toBe(fixture.expected.mutationId);
    expect(descriptor.detected).toBe(fixture.expected.detected);
    for (const traceName of descriptor.traces) {
      const mutation = readJson<TraceArtifact>(
        `${fixture.path!}/${traceName}`,
      );
      expect(classifyEvidenceArtifact(mutation)).toBe("trace");
      expect(mutation.mutation).toEqual({ id: descriptor.id, planted: true });
      expect(mutation.passed).toBe(false);
      expect(traceName).toBe(path.basename(caseById("baseline-passing").path!));
      expect(baseline.mutation).toBeUndefined();
    }
  });

  it("rejects duplicate proof IDs", () => {
    const fixture = caseById("duplicate-proof-id");
    const traces = fixture.paths!.map((entry) =>
      readJson<TraceArtifact>(entry),
    );
    expect(
      traces.every((trace) => classifyEvidenceArtifact(trace) === "trace"),
    ).toBe(true);
    expect(new Set(traces.map((trace) => trace.proofId)).size).toBeLessThan(
      traces.length,
    );
    expect(fixture.expected.error).toBe("duplicate_proof_id");
  });

  it("rejects malformed JSON and trace shapes", () => {
    const malformedJson = caseById("malformed-json");
    expect(() => JSON.parse(readText(malformedJson.path!))).toThrow(SyntaxError);
    expect(malformedJson.expected.error).toBe("invalid_json");

    const malformedShape = caseById("malformed-trace-shape");
    expect(classifyEvidenceArtifact(readJson(malformedShape.path!))).toBe(
      "reject",
    );
    expect(malformedShape.expected.error).toBe("trace_shape");
  });

  it("routes malformed manifests through manifest_shape errors", () => {
    const fixture = caseById("malformed-manifest");
    const result = validateMission({
      manifest: readJson(fixture.path!),
      capabilities,
      schema,
      traces: [],
    });
    expect(result.ok).toBe(false);
    expect(issueCategories(result.issues)).toEqual(
      fixture.expected.issueCategories,
    );
  });
});
