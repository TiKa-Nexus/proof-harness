// Import External Packages
import { beforeEach, describe, expect, it, vi } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import { seed } from "../server/seed";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// The harness never invents a column value it wasn't given (issue #9: a
// hardcoded `type: "team"` broke every consumer whose workspaces table
// dropped the column). These tests pin the insert payload of
// `seed.workspace`: exactly `name` plus caller-supplied columns, with the
// given `name` argument winning over a colliding override.
// ---------------------------------------------------------------------------

const insertPayloads: Array<Record<string, unknown>> = [];

vi.mock("../server/service-client", () => ({
  createProofServiceClient: () => ({
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        insertPayloads.push({ ...payload });
        return {
          select: () => ({
            single: async () => ({
              data: {
                id: "workspace-1",
                name: payload.name,
                owner_id: null,
              },
              error: null,
              status: 201,
              _table: table,
            }),
          }),
        };
      },
    }),
  }),
}));

beforeEach(() => {
  insertPayloads.length = 0;
});

describe("seed.workspace insert payload", () => {
  it("writes only the given name by default — no invented columns", async () => {
    const workspace = await seed.workspace("Proof OrgA");
    expect(insertPayloads).toEqual([{ name: "Proof OrgA" }]);
    expect(workspace).toEqual({
      id: "workspace-1",
      name: "Proof OrgA",
      ownerId: null,
    });
  });

  it("passes caller-supplied columns through verbatim", async () => {
    await seed.workspace("Proof OrgA", {
      columns: { type: "team", plan: "pro" },
    });
    expect(insertPayloads).toEqual([
      { type: "team", plan: "pro", name: "Proof OrgA" },
    ]);
  });

  it("keeps the name argument authoritative over a colliding override", async () => {
    await seed.workspace("Proof OrgA", { columns: { name: "Impostor" } });
    expect(insertPayloads).toEqual([{ name: "Proof OrgA" }]);
  });
});
