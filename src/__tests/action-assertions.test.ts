// Import External Packages
import type { Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

const recorded: Array<Record<string, unknown>> = [];
const invokeAction = vi.fn();

vi.mock("../playwright/actAsUser", () => ({
  actAsUser: { invokeAction, supabaseClient: vi.fn() },
}));
vi.mock("../playwright/trace", () => ({
  recordAssertion: (assertion: Record<string, unknown>) =>
    recorded.push(assertion),
  withAssertionProvenance: (_helper: string, fn: () => Promise<unknown>) =>
    fn(),
  withoutAssertionProvenance: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../server/service-client", () => ({
  createProofServiceClient: vi.fn(),
}));

const { assert } = await import("../playwright/assert");
const page = {} as Page;

beforeEach(() => {
  process.env.SEED_ADMIN_EMAIL = "admin@example.test";
  process.env.SEED_ADMIN_PASSWORD = "admin-test-password";
  process.env.SEED_MEMBER_EMAIL = "member@example.test";
  process.env.SEED_MEMBER_PASSWORD = "member-test-password";
  recorded.length = 0;
  invokeAction.mockReset();
});

describe("action assertion evidence", () => {
  it("records a refusal under the action's declared invariant kind", async () => {
    invokeAction.mockResolvedValue({
      success: false,
      error: "duplicate event",
    });
    await assert.authorization({
      actor: "member",
      action: {
        module: "github",
        name: "ingestWebhook",
        inputParams: { deliveryId: "same-id" },
        kind: "idempotency",
      },
      page,
    });
    expect(recorded).toContainEqual(
      expect.objectContaining({
        kind: "idempotency",
        target: "github:ingestWebhook",
        passed: true,
        role: "primary",
      }),
    );
  });

  it("records successful actions as controls and returns their data", async () => {
    invokeAction.mockResolvedValue({
      success: true,
      data: { projectId: "project-1" },
    });
    await expect(
      assert.actionSucceeds<{ projectId: string }>({
        actor: "admin",
        action: {
          module: "project",
          name: "createProject",
          inputParams: { name: "Allowed" },
          kind: "tenant_isolation",
        },
        page,
      }),
    ).resolves.toEqual({ projectId: "project-1" });
    expect(recorded).toContainEqual(
      expect.objectContaining({
        kind: "tenant_isolation",
        target: "project:createProject",
        passed: true,
        role: "control",
      }),
    );
  });

  it("fails rather than certifying a control when the allowed action rejects", async () => {
    invokeAction.mockResolvedValue({
      success: false,
      error: "action is broken for everyone",
    });
    await expect(
      assert.actionSucceeds({
        actor: "admin",
        action: {
          module: "project",
          name: "createProject",
          inputParams: { name: "Allowed" },
          kind: "tenant_isolation",
        },
        page,
      }),
    ).rejects.toThrow(/\[PROOF_FAIL\] tenant_isolation:/);
    expect(recorded).toContainEqual(
      expect.objectContaining({
        kind: "tenant_isolation",
        passed: false,
        role: "control",
      }),
    );
  });
});
