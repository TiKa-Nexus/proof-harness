// Import External Packages
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import {
  recordAssertion,
  trace,
  withAssertionProvenance,
  withoutAssertionProvenance,
} from "../playwright/trace";
import type { TraceArtifact } from "../shared/trace-types";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// `emittedBy` is only trustworthy if it can ONLY come from the SDK itself.
// These tests pin the two rules that make it evidence rather than a string:
//
//   1. The public recordAssertion strips a caller-supplied `emittedBy`, so a
//      spec cannot impersonate a helper on a hand-rolled assertion.
//   2. Assertions recorded while `withAssertionProvenance` is active carry the
//      helper name — which is how every `assert.*` helper stamps its output.
//
// The trace recorder writes to `<cwd>/.proof/traces`, so the suite runs inside
// a throwaway working directory, the same way the CLI-facing scripts are
// tested.
// ---------------------------------------------------------------------------

let dir: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-provenance-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

function readArtifact(proofId: string): TraceArtifact {
  return JSON.parse(
    fs.readFileSync(
      path.join(dir, ".proof", "traces", `${proofId}.json`),
      "utf8",
    ),
  ) as TraceArtifact;
}

describe("assertion provenance", () => {
  it("strips a caller-supplied emittedBy from spec-recorded assertions", async () => {
    await trace.proof("forged-provenance", async (t) => {
      await t.step(
        { intent: "probe", kind: "tenant_isolation", target: "widgets" },
        async () => {
          recordAssertion({
            kind: "tenant_isolation",
            target: "widgets",
            passed: true,
            role: "primary",
            // A spec trying to impersonate the helper:
            emittedBy: "assert.tenantIsolation",
          });
        },
      );
    });

    const artifact = readArtifact("forged-provenance");
    const assertion = artifact.steps[0]?.assertions?.[0];
    expect(assertion).toBeDefined();
    expect(assertion?.emittedBy).toBeUndefined();
  });

  it("stamps assertions recorded inside withAssertionProvenance", async () => {
    await trace.proof("helper-provenance", async (t) => {
      await t.step(
        { intent: "probe", kind: "tenant_isolation", target: "widgets" },
        async () => {
          await withAssertionProvenance("assert.tenantIsolation", async () => {
            recordAssertion({
              kind: "tenant_isolation",
              target: "widgets",
              passed: true,
              role: "primary",
            });
          });
          // Outside the helper context again: no stamp.
          recordAssertion({
            kind: "happy_path",
            target: "widgets",
            passed: true,
            role: "control",
          });
        },
      );
    });

    const assertions = readArtifact("helper-provenance").steps[0]?.assertions;
    expect(assertions?.[0]?.emittedBy).toBe("assert.tenantIsolation");
    expect(assertions?.[1]?.emittedBy).toBeUndefined();
  });

  it("does not stamp assertions from user callbacks the helper suspends", async () => {
    // The regression this pins: helpers invoke executor-authored callbacks
    // (fixture.create, setup) INSIDE their own provenance context.
    // assert.tenantIsolation wraps those calls in withoutAssertionProvenance;
    // a hostile fixture recording its own "evidence" must come out unstamped,
    // while the helper's own assertions before and after stay stamped.
    await trace.proof("hostile-fixture", async (t) => {
      await t.step(
        { intent: "probe", kind: "tenant_isolation", target: "widgets" },
        async () => {
          await withAssertionProvenance("assert.tenantIsolation", async () => {
            // Hostile fixture callback, as the helper runs it:
            await withoutAssertionProvenance(async () => {
              recordAssertion({
                kind: "tenant_isolation",
                target: "widgets",
                passed: true,
                role: "primary",
                emittedBy: "assert.tenantIsolation",
              });
            });
            // The helper's own probe assertion, after the callback returns:
            recordAssertion({
              kind: "tenant_isolation",
              target: "widgets",
              passed: true,
              role: "primary",
            });
          });
        },
      );
    });

    const assertions = readArtifact("hostile-fixture").steps[0]?.assertions;
    expect(assertions?.[0]?.emittedBy).toBeUndefined();
    expect(assertions?.[1]?.emittedBy).toBe("assert.tenantIsolation");
  });

  it("keeps the context's name even when a forged one is supplied inside a helper", async () => {
    await trace.proof("context-wins", async (t) => {
      await t.step(
        { intent: "probe", kind: "authorization", target: "widgets" },
        async () => {
          await withAssertionProvenance("assert.authorization", async () => {
            recordAssertion({
              kind: "authorization",
              target: "widgets",
              passed: true,
              role: "primary",
              emittedBy: "assert.tenantIsolation",
            });
          });
        },
      );
    });

    const assertion = readArtifact("context-wins").steps[0]?.assertions?.[0];
    expect(assertion?.emittedBy).toBe("assert.authorization");
  });
});

it.each([undefined, null, false, 0, ""])(
  "records and rethrows falsy failures (%s)",
  async (error) => {
    let caught = false;
    try {
      await trace.proof("falsy", async () => {
        throw error;
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dir, ".proof/traces/falsy.json"), "utf8"),
      ).passed,
    ).toBe(false);
  },
);
it("fails the proof when a callback records failure without throwing", async () => {
  await expect(
    trace.proof("recorded", async (t) => {
      await t.step(
        { kind: "happy_path", target: "widgets", intent: "observe" },
        async () => {
          recordAssertion({
            kind: "happy_path",
            target: "widgets",
            passed: false,
          });
        },
      );
    }),
  ).rejects.toThrow(/recorded assertions failed/);
});
it("rejects duplicate proof IDs without overwriting the first artifact", async () => {
  await trace.proof("duplicate", async () => {});
  const file = path.join(dir, ".proof/traces/duplicate.json");
  const first = fs.readFileSync(file, "utf8");
  await expect(trace.proof("duplicate", async () => {})).rejects.toThrow(
    /duplicate_proof_id/,
  );
  expect(fs.readFileSync(file, "utf8")).toBe(first);
});
it("honors configured and runner-overridden trace paths", () => {
  fs.writeFileSync(
    path.join(dir, "proof.config.mjs"),
    'export default {artifacts:{traces:"evidence/output"}};',
  );
  const writer = pathToFileURL(
    path.join(previousCwd, "dist/playwright.js"),
  ).href;
  const run = (id: string, output?: string) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {trace} from ${JSON.stringify(writer)}; await trace.proof(${JSON.stringify(id)},async () => {});`,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(output ? { PROOF_TRACES_DIR: output } : {}),
        },
      },
    );
  const configured = run("configured");
  expect(configured.status, configured.stderr).toBe(0);
  expect(fs.existsSync(path.join(dir, "evidence/output/configured.json"))).toBe(
    true,
  );
  const overridden = run("overridden", path.join(dir, "runner-output"));
  expect(overridden.status, overridden.stderr).toBe(0);
  expect(fs.existsSync(path.join(dir, "runner-output/overridden.json"))).toBe(
    true,
  );
});
