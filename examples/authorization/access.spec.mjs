import { test, expect } from "@playwright/test";
import { trace, recordAssertion } from "proof-harness/playwright";
import { canReadDocument } from "./access.mjs";

test("a document is visible only within its workspace", async () => {
  await trace.proof("document-access", async (t) => {
    const document = { workspaceId: "workspace-a" };
    await t.step(
      {
        intent: "An owner can read their document",
        kind: "authorization",
        target: "document",
      },
      async () => {
        const allowed = canReadDocument(
          { workspaceId: "workspace-a" },
          document,
        );
        recordAssertion({
          kind: "authorization",
          target: "document",
          operation: "select",
          role: "control",
          passed: allowed,
        });
        expect(allowed).toBe(true);
      },
    );
    await t.step(
      {
        intent: "Another workspace cannot read the document",
        kind: "authorization",
        target: "document",
      },
      async () => {
        const allowed = canReadDocument(
          { workspaceId: "workspace-b" },
          document,
        );
        recordAssertion({
          kind: "authorization",
          target: "document",
          operation: "select",
          role: "primary",
          passed: !allowed,
        });
        expect(allowed).toBe(false);
      },
    );
  });
});
