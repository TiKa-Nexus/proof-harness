import fs from "node:fs";
import { expect, it } from "vitest";
import { decodeTrace } from "proof-harness/node";
import { assertionSelectorsTurnedRed } from "../cli/engines/proof_control_sensitivity.mjs";
const fixture = JSON.parse(
  fs.readFileSync(
    "proof-consumer-fixtures/mutations/primary-rpc/failed.json",
    "utf8",
  ),
);
const selector = {
  kind: "authorization",
  target: "deduct_workspace_credits",
  operation: "invoke",
};
const copy = () => structuredClone(fixture);
it("detects the mapped explicit primary RPC failure accepted by trace ingestion", () => {
  const trace = decodeTrace(copy());
  expect(assertionSelectorsTurnedRed([trace], [selector], "primary")).toBe(
    true,
  );
});
it.each(["control", "positive_control"])(
  "does not count the same failed key with role %s as primary",
  (role) => {
    const trace = copy();
    trace.steps[0].assertions[0].role = role;
    expect(assertionSelectorsTurnedRed([trace], [selector], "primary")).toBe(
      false,
    );
  },
);
it.each(["incomplete", "skipped"])(
  "does not detect a %s explicit primary",
  (status) => {
    const trace = copy();
    trace.steps[0].assertions[0].status = status;
    expect(assertionSelectorsTurnedRed([trace], [selector], "primary")).toBe(
      false,
    );
  },
);
it("keeps SDK origin requirements for controls and explicit selector restrictions", () => {
  const trace = copy();
  expect(
    assertionSelectorsTurnedRed(
      [trace],
      [{ ...selector, emittedBy: "assert.authorization" }],
      "primary",
    ),
  ).toBe(false);
  trace.steps[0].assertions[0].role = "control";
  expect(assertionSelectorsTurnedRed([trace], [selector], "control")).toBe(
    false,
  );
});
it("rejects setup failures without a decisive assertion and mismatched claims", () => {
  const trace = copy();
  trace.steps[0].error = "[PROOF_FAIL] setup: RPC unavailable";
  trace.steps[0].assertions = [];
  expect(assertionSelectorsTurnedRed([trace], [selector], "primary")).toBe(
    false,
  );
  expect(
    assertionSelectorsTurnedRed(
      [copy()],
      [{ ...selector, target: "other_rpc" }],
      "primary",
    ),
  ).toBe(false);
});
it("continues rejecting invented helper origins", () => {
  const trace = copy();
  trace.steps[0].assertions[0].emittedBy = "custom-rpc-helper";
  expect(() => decodeTrace(trace)).toThrow("emittedBy");
  expect(assertionSelectorsTurnedRed([trace], [selector], "primary")).toBe(
    false,
  );
});
