import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decodeTrace } from "proof-harness/node";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, "access.mjs");
const original = fs.readFileSync(source, "utf8");
const rule = "return actor.workspaceId === document.workspaceId;";
assert.equal(
  original.split(rule).length,
  2,
  "Expected the original example rule",
);
const cli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
const output = fs.mkdtempSync(path.join(root, ".proof-demo-"));

function run(name, expectedPass) {
  const traces = path.join(output, name);
  const result = spawnSync(
    process.execPath,
    [cli, "test", "--config", "playwright.config.mjs"],
    {
      cwd: root,
      env: { ...process.env, PROOF_TRACES_DIR: traces },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.signal, null, "Proof process was interrupted");
  assert.equal(result.status, expectedPass ? 0 : 1);
  const evidence = decodeTrace(
    JSON.parse(
      fs.readFileSync(path.join(traces, "document-access.json"), "utf8"),
    ),
  );
  assert.equal(evidence.passed, expectedPass);
  const primary = evidence.steps
    .flatMap((step) => step.assertions ?? [])
    .find((a) => a.role === "primary");
  assert.ok(primary, "Missing primary assertion");
  assert.equal(primary.passed, expectedPass);
  assert.equal(primary.status, expectedPass ? "passed" : "failed");
  console.log(
    `${name}: confirmed ${expectedPass ? "passing" : "failed"} primary evidence`,
  );
}

try {
  run("baseline", true);
  fs.writeFileSync(
    source,
    original.replace(
      rule,
      "return true; // Deliberately broken: every workspace is allowed.",
    ),
  );
  run("broken", false);
} finally {
  fs.writeFileSync(source, original);
}
console.log(
  `Demo succeeded: the broken rule was detected and the source restored. Traces: ${output}`,
);
