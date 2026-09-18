import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { sourceHash, readTraceDirectory } from "proof-harness/node";
it("invalidates isolation evidence after the consumer fixture source changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-source-"));
  try {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const write = (name: string, value: string) => {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    };
    const spec =
      "// calls the public tenantIsolation helper with the consumer fixture";
    write("e2e/proofs/isolation.proof.ts", spec);
    write(
      "e2e/fixtures/isolated-accounts.ts",
      "export const fixtureId = 'two-accounts-v1';",
    );
    const original = sourceHash(root);
    write(
      ".proof/traces/isolation.json",
      JSON.stringify({
        schemaVersion: 2,
        proofId: "isolation",
        specFile: "e2e/proofs/isolation.proof.ts",
        specHash: crypto
          .createHash("sha256")
          .update(spec)
          .digest("hex")
          .slice(0, 12),
        sourceHash: original,
        timestamp: new Date().toISOString(),
        durationMs: 1,
        passed: true,
        steps: [
          {
            intent: "separate accounts",
            kind: "tenant_isolation",
            target: "notifications",
            observation: "isolated",
            durationMs: 1,
            passed: true,
            assertions: [
              {
                kind: "tenant_isolation",
                target: "notifications",
                operation: "select",
                passed: true,
                status: "passed",
                role: "primary",
                emittedBy: "assert.tenantIsolation",
                detail: "fixture two-accounts-v1",
              },
            ],
          },
        ],
      }),
    );
    expect(
      readTraceDirectory(path.join(root, ".proof/traces"), { rootDir: root }),
    ).toHaveLength(1);
    write(
      "e2e/fixtures/isolated-accounts.ts",
      "export const fixtureId = 'changed-setup';",
    );
    expect(sourceHash(root)).not.toBe(original);
    expect(() =>
      readTraceDirectory(path.join(root, ".proof/traces"), { rootDir: root }),
    ).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
