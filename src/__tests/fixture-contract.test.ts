// Import External Packages
import { beforeEach, describe, expect, it, vi } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

const recorded: Array<Record<string, unknown>> = [];
const deleteWorkspace = vi.fn(async () => undefined);
const deleteUser = vi.fn(async () => undefined);

const orgs = [
  { id: "org-a", name: "Org A", ownerId: null },
  { id: "org-b", name: "Org B", ownerId: null },
];
const users = [
  {
    id: "user-a",
    email: "a@proof.test",
    password: "pass-a",
    workspaceId: "org-a",
    role: "owner" as const,
    membershipId: "member-a",
  },
  {
    id: "user-b",
    email: "b@proof.test",
    password: "pass-b",
    workspaceId: "org-b",
    role: "owner" as const,
    membershipId: "member-b",
  },
];

let workspaceIndex = 0;
let userIndex = 0;
let serviceRows: Array<Record<string, unknown>> = [];
const queryCalls: Array<{
  client: string;
  table: string;
  filter: Record<string, unknown>;
}> = [];

function matchingRows(
  rows: Array<Record<string, unknown>>,
  filter: Record<string, unknown>,
) {
  return rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => row[key] === value),
  );
}

function fakeSelectClient(
  client: string,
  rows: Array<Record<string, unknown>>,
  { count = false } = {},
) {
  return {
    from(table: string) {
      return {
        select() {
          const call = { client, table, filter: {} as Record<string, unknown> };
          queryCalls.push(call);
          const builder = {
            eq(column: string, value: unknown) {
              call.filter[column] = value;
              return builder;
            },
            then<TResult1 = unknown, TResult2 = never>(
              onfulfilled?:
                | ((value: unknown) => TResult1 | PromiseLike<TResult1>)
                | null,
              onrejected?:
                | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
                | null,
            ) {
              const matched = matchingRows(rows, call.filter);
              return Promise.resolve({
                data: count ? null : matched,
                count: count ? matched.length : null,
                error: null,
                status: 200,
              }).then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
      };
    },
  };
}

vi.mock("../server/seed", () => ({
  seed: {
    workspace: async () => orgs[workspaceIndex++],
    user: async () => users[userIndex++],
    deleteWorkspace,
    deleteUser,
  },
}));

vi.mock("../server/service-client", () => ({
  createProofServiceClient: () =>
    fakeSelectClient("service", serviceRows, { count: true }),
}));

vi.mock("../playwright/trace", () => ({
  recordAssertion: (assertion: Record<string, unknown>) =>
    recorded.push(assertion),
  withAssertionProvenance: (_helper: string, fn: () => Promise<unknown>) =>
    fn(),
  withoutAssertionProvenance: (fn: () => Promise<unknown>) => fn(),
}));

const supabaseClient = vi.fn();

vi.mock("../playwright/actAsUser", () => ({
  actAsUser: {
    supabaseClient,
    loginAs: vi.fn(),
  },
}));

const { assert: proofAssert } = await import("../playwright/assert");
const { defineProofFixture, pendingProofFixture, ProofFixturePendingError } =
  await import("../server/fixture");

beforeEach(() => {
  recorded.length = 0;
  workspaceIndex = 0;
  userIndex = 0;
  serviceRows = [];
  queryCalls.length = 0;
  supabaseClient.mockReset();
  deleteWorkspace.mockClear();
  deleteUser.mockClear();
});

function primaryAssertions() {
  return recorded.filter((assertion) => assertion.role === "primary");
}

function controlAssertions() {
  return recorded.filter((assertion) => assertion.role === "control");
}

describe("proof fixture factory contract", () => {
  it("keeps the declared table attached to a completed factory", async () => {
    const create = vi.fn(async () => undefined);
    const fixture = defineProofFixture({ table: "widgets", create });
    const context = { marker: "context" };

    await fixture.create(context as never);

    expect(fixture.table).toBe("widgets");
    expect(create).toHaveBeenCalledWith(context);
    expect(Object.isFrozen(fixture)).toBe(true);
  });

  it.each([
    "required primitive columns are not final",
    "a required foreign key has no seeded referenced row",
    "a CHECK constraint carries product meaning",
    "the column uses a domain or enum with product-specific values",
  ])("keeps pre-schema setup incomplete: %s", async (reason) => {
    const fixture = pendingProofFixture("widgets", reason);

    await expect(fixture.create({} as never)).rejects.toMatchObject({
      name: "ProofFixturePendingError",
      code: "fixture_factory_required",
      table: "widgets",
      reason,
    });
    await expect(fixture.create({} as never)).rejects.toThrow(
      "Complete e2e/fixtures/widgets.ts",
    );
  });

  it("uses a dedicated error type for pending factories", () => {
    const error = new ProofFixturePendingError("widgets", "schema is unknown");

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("fixture_factory_required");
  });
});

describe("assert.tenantIsolation fixture safety", () => {
  it("records a pending factory as incomplete and never as green", async () => {
    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: pendingProofFixture(
          "widgets",
          "required columns and constraints are not known yet",
        ),
        tag: "pending",
      }),
    ).rejects.toThrow(/fixture_factory_required/);

    expect(primaryAssertions()).toEqual([
      expect.objectContaining({
        target: "widgets",
        passed: false,
        status: "incomplete",
        detail: expect.stringContaining("required columns"),
      }),
    ]);
    expect(recorded.some((assertion) => assertion.passed === true)).toBe(false);
    expect(deleteWorkspace).toHaveBeenCalledTimes(2);
    expect(deleteUser).toHaveBeenCalledTimes(2);
  });

  it("rejects a factory copied from another table before it inserts", async () => {
    const create = vi.fn(async () => undefined);

    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: defineProofFixture({ table: "projects", create }),
        tag: "mismatch",
      }),
    ).rejects.toThrow(/fixture_factory_mismatch/);

    expect(create).not.toHaveBeenCalled();
    expect(primaryAssertions()).toEqual([
      expect.objectContaining({
        target: "widgets",
        passed: false,
        status: "incomplete",
        detail: expect.stringContaining('fixture for "projects"'),
      }),
    ]);
  });

  it("records an empty completed factory as incomplete instead of passing vacuously", async () => {
    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: defineProofFixture({
          table: "widgets",
          async create() {
            // Deliberately creates no row.
          },
        }),
        tag: "empty",
      }),
    ).rejects.toThrow(/tenant_isolation_vacuous/);

    expect(primaryAssertions()).toEqual([
      expect.objectContaining({
        target: "widgets",
        passed: false,
        status: "incomplete",
        detail: expect.stringContaining("created 0 rows"),
      }),
    ]);
    expect(recorded.some((assertion) => assertion.passed === true)).toBe(false);
  });

  it("treats wrong-state rows as vacuous under a planner-owned criterion", async () => {
    serviceRows = [
      {
        id: "draft-a",
        workspace_id: "org-a",
        status: "draft",
      },
    ];

    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: defineProofFixture({
          table: "widgets",
          async create() {
            // The executor produced a real row, but not the semantic state the
            // protected proof requires.
          },
        }),
        criterion: {
          description: "published widgets",
          where: { status: "published" },
        },
        tag: "wrong-state",
      }),
    ).rejects.toThrow(/tenant_isolation_vacuous/);

    expect(queryCalls).toEqual([
      {
        client: "service",
        table: "widgets",
        filter: {
          workspace_id: "org-a",
          status: "published",
        },
      },
    ]);
    expect(primaryAssertions()).toEqual([
      expect.objectContaining({
        passed: false,
        status: "incomplete",
        detail: expect.stringContaining("published widgets"),
      }),
    ]);
  });

  it("applies the same semantic criterion to both controls and both outsider probes", async () => {
    const publishedA = {
      id: "published-a",
      workspace_id: "org-a",
      status: "published",
    };
    const publishedB = {
      id: "published-b",
      workspace_id: "org-b",
      status: "published",
    };
    serviceRows = [publishedA, publishedB];
    supabaseClient
      .mockResolvedValueOnce(fakeSelectClient("owner-a", [publishedA]) as never)
      .mockResolvedValueOnce(fakeSelectClient("viewer-b", []) as never)
      .mockResolvedValueOnce(fakeSelectClient("owner-b", [publishedB]) as never)
      .mockResolvedValueOnce(fakeSelectClient("viewer-a", []) as never);

    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: defineProofFixture({
          table: "widgets",
          async create() {
            // Rows are represented by serviceRows in this unit-level harness.
          },
        }),
        criterion: {
          description: "published widgets",
          where: { status: "published" },
        },
        tag: "matching-state",
      }),
    ).resolves.toBeUndefined();

    expect(queryCalls).toHaveLength(6);
    expect(
      queryCalls.map(({ client, filter }) => ({ client, filter })),
    ).toEqual([
      {
        client: "service",
        filter: { workspace_id: "org-a", status: "published" },
      },
      {
        client: "owner-a",
        filter: { workspace_id: "org-a", status: "published" },
      },
      {
        client: "viewer-b",
        filter: { workspace_id: "org-a", status: "published" },
      },
      {
        client: "service",
        filter: { workspace_id: "org-b", status: "published" },
      },
      {
        client: "owner-b",
        filter: { workspace_id: "org-b", status: "published" },
      },
      {
        client: "viewer-a",
        filter: { workspace_id: "org-b", status: "published" },
      },
    ]);
    expect(primaryAssertions()).toHaveLength(2);
    expect(primaryAssertions()).toEqual([
      expect.objectContaining({
        passed: true,
        detail: expect.stringContaining("published widgets"),
      }),
      expect.objectContaining({
        passed: true,
        detail: expect.stringContaining("published widgets"),
      }),
    ]);
    expect(controlAssertions()).toHaveLength(2);
  });

  it("rejects criteria that try to pin the tenant scope column", async () => {
    const create = vi.fn(async () => undefined);

    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: defineProofFixture({ table: "widgets", create }),
        criterion: {
          description: "a hand-picked tenant",
          where: { workspace_id: "org-a" },
        },
        tag: "scope-collision",
      }),
    ).rejects.toThrow(/fixture_criterion_invalid/);

    expect(create).not.toHaveBeenCalled();
    expect(queryCalls).toEqual([]);
    expect(primaryAssertions()).toEqual([
      expect.objectContaining({
        passed: false,
        status: "incomplete",
        detail: expect.stringContaining("scope column"),
      }),
    ]);
  });
});
