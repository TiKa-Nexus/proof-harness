import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeTrace, decodeTraceBundle } from "proof-harness/node";
const read = (p: string) =>
  JSON.parse(fs.readFileSync(`proof-consumer-fixtures/${p}`, "utf8"));
describe("production evidence decoder", () => {
  it("accepts a valid baseline", () =>
    expect(
      decodeTrace(read("baseline/passing/widgets-tenant-isolation.json"))
        .passed,
    ).toBe(true));
  it("rejects contradictory statuses", () =>
    expect(() =>
      decodeTrace(read("malformed/contradictory-status.json")),
    ).toThrow(/status/));
  it("rejects duplicate IDs", () =>
    expect(() =>
      decodeTraceBundle([
        read("duplicates/first/widgets-tenant-isolation.json"),
        read("duplicates/second/widgets-tenant-isolation.json"),
      ]),
    ).toThrow(/duplicate_proof_id/));
  it("rejects unsupported shapes", () =>
    expect(() => decodeTrace({ schemaVersion: 999, steps: [] })).toThrow(
      /trace_shape/,
    ));
});
