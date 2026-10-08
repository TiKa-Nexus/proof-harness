import fs from "node:fs";
import path from "node:path";
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

const projections: Array<{ client: string; selection: string }> = [];
let columnRestricted = false;
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
        select(selection = "*") {
          projections.push({ client, selection });
          const forbidden =
            columnRestricted &&
            client !== "service" &&
            selection !== "id,account_id";
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
                data: forbidden || count ? null : matched,
                count: count ? matched.length : null,
                error: forbidden
                  ? { code: "42501", message: "column permission denied" }
                  : null,
                status: forbidden ? 403 : 200,
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

vi.mock("../playwright/trace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../playwright/trace")>();
  return {
    ...actual,
    recordAssertion: (
      assertion: import("../shared/trace-types").TraceAssertion,
    ) => {
      recorded.push(assertion as unknown as Record<string, unknown>);
      actual.recordAssertion(assertion);
    },
  };
});

const supabaseClient = vi.fn();
const loginAs = vi.fn();
const logout = vi.fn(async () => undefined);

vi.mock("../playwright/actAsUser", () => ({
  actAsUser: {
    supabaseClient,
    loginAs,
    logout,
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
  projections.length = 0;
  columnRestricted = false;
  supabaseClient.mockReset();
  loginAs.mockReset();
  logout.mockClear();
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

  it("logs a supplied browser out before deleting disposable users", async () => {
    const page = { marker: "browser page" };

    await expect(
      proofAssert.tenantIsolation({
        table: "widgets",
        fixture: pendingProofFixture("widgets", "schema is still pending"),
        page: page as never,
        tag: "browser-cleanup",
      }),
    ).rejects.toThrow(/fixture_factory_required/);

    expect(logout).toHaveBeenCalledWith(page);
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(
      deleteUser.mock.invocationCallOrder[0],
    );
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

it("fails visibly when fixture cleanup fails", async () => {
  deleteWorkspace.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(
    proofAssert.tenantIsolation({ table: "widgets", setup: async () => {} }),
  ).rejects.toThrow(/fixture_cleanup/);
  expect(deleteUser).toHaveBeenCalledTimes(2);
});

describe("caller-owned isolation fixture", () => {
  function options(column = "account_id") {
    serviceRows = [
      { id: "row-a", [column]: "a" },
      { id: "row-b", [column]: "b" },
    ];
    supabaseClient.mockImplementation(async ({ email }) =>
      fakeSelectClient(
        email,
        serviceRows.filter(
          (r) => r[column] === (email === "a@proof.test" ? "a" : "b"),
        ),
      ),
    );
    return {
      table: "widgets",
      scopeColumn: column,
      isolationFixture: {
        id: "widgets-v1",
        table: "widgets",
        setup: vi.fn(async () => ({
          a: {
            actor: { email: "a@proof.test", password: "a" },
            scopeValue: "a",
          },
          b: {
            actor: { email: "b@proof.test", password: "b" },
            scopeValue: "b",
          },
        })),
        cleanup: vi.fn(async () => undefined),
      },
    };
  }
  it("uses readable columns consistently while preserving both owner controls and denials", async () => {
    const opts = options();
    columnRestricted = true;
    await proofAssert.tenantIsolation({
      ...opts,
      columns: ["id", "account_id"],
    });
    expect(primaryAssertions().filter((a) => a.passed)).toHaveLength(2);
    expect(controlAssertions().filter((a) => a.passed)).toHaveLength(2);
    expect(projections).toHaveLength(8);
    expect(projections.every((p) => p.selection === "id,account_id")).toBe(
      true,
    );
  });
  it("retains default all-column behavior and refuses an unreadable owner projection", async () => {
    const opts = options();
    columnRestricted = true;
    await expect(proofAssert.tenantIsolation(opts)).rejects.toThrow(
      /tenant_isolation_control/,
    );
    expect(primaryAssertions().some((a) => a.passed)).toBe(false);
  });
  it.each(["blocked", "leak"])(
    "selected columns still detect %s access",
    async (mode) => {
      const opts = options();
      columnRestricted = true;
      supabaseClient.mockImplementation(async () =>
        fakeSelectClient(mode, mode === "leak" ? serviceRows : []),
      );
      await expect(
        proofAssert.tenantIsolation({ ...opts, columns: ["id", "account_id"] }),
      ).rejects.toThrow(
        mode === "blocked" ? /tenant_isolation_control/ : /tenant_isolation/,
      );
      expect(opts.isolationFixture.cleanup).toHaveBeenCalledOnce();
    },
  );
  it.each(
    [
      [],
      ["*"],
      ["id", "id"],
      ["id,count()"],
      ["alias:id"],
      ["other(id)"],
      ["id::text"],
      ["id "],
    ].map((columns) => ({ columns })),
  )("rejects unsafe or ambiguous projections $columns", async ({ columns }) => {
    const opts = options();
    await expect(
      proofAssert.tenantIsolation({ ...opts, columns }),
    ).rejects.toThrow(/tenant_isolation_setup/);
    expect(opts.isolationFixture.setup).not.toHaveBeenCalled();
    expect(projections).toHaveLength(0);
  });
  it.each(["account_id", "user_id"])(
    "proves both directions for %s without workspace resources",
    async (column) => {
      const opts = options(column);
      await proofAssert.tenantIsolation(opts);
      expect(primaryAssertions().filter((a) => a.passed)).toHaveLength(2);
      expect(controlAssertions().filter((a) => a.passed)).toHaveLength(2);
      expect(workspaceIndex).toBe(0);
      expect(userIndex).toBe(0);
      expect(opts.isolationFixture.cleanup).toHaveBeenCalledOnce();
    },
  );
  it.each(["empty", "blocked", "leak", "malformed", "cleanup"])(
    "fails closed for %s",
    async (mode) => {
      const opts = options();
      if (mode === "empty") serviceRows = serviceRows.slice(0, 1);
      if (mode === "blocked")
        supabaseClient.mockImplementation(async () =>
          fakeSelectClient("blocked", []),
        );
      if (mode === "leak")
        supabaseClient.mockImplementation(async () =>
          fakeSelectClient("leak", serviceRows),
        );
      if (mode === "malformed")
        opts.isolationFixture.setup.mockResolvedValue({
          a: { actor: { email: "a", password: "a" }, scopeValue: "same" },
          b: { actor: { email: "b", password: "b" }, scopeValue: "same" },
        });
      if (mode === "cleanup")
        opts.isolationFixture.cleanup.mockRejectedValue(
          new Error("cleanup failed"),
        );
      await expect(proofAssert.tenantIsolation(opts)).rejects.toThrow();
      expect(opts.isolationFixture.cleanup).toHaveBeenCalledOnce();
      if (mode === "blocked")
        expect(controlAssertions().some((a) => !a.passed)).toBe(true);
      if (mode === "cleanup")
        expect(primaryAssertions().some((a) => a.status === "incomplete")).toBe(
          true,
        );
    },
  );
  it("preserves SDK provenance while setup and cleanup assertions remain caller-owned", async () => {
    const { trace, recordAssertion } = await import("../playwright/trace");
    const directory = fs.mkdtempSync(
      path.join(process.cwd(), ".proof-isolation-"),
    );
    const previous = process.env.PROOF_TRACES_DIR;
    process.env.PROOF_TRACES_DIR = directory;
    const opts = options();
    const setup = opts.isolationFixture.setup;
    const forged = () =>
      recordAssertion({
        kind: "tenant_isolation",
        target: "forged",
        operation: "select",
        role: "primary",
        passed: true,
        emittedBy: "assert.tenantIsolation",
      });
    opts.isolationFixture.setup = vi.fn(async () => {
      forged();
      const sides = await setup();
      return {
        ...sides,
        a: {
          ...sides.a,
          get actor() {
            forged();
            return sides.a.actor;
          },
        },
      };
    });
    opts.isolationFixture.cleanup = vi.fn(async () => {
      forged();
    });
    try {
      await trace.proof("custom-isolation", async (t) => {
        await t.step(
          {
            kind: "tenant_isolation",
            target: "widgets",
            intent: "independent scopes",
          },
          async () => proofAssert.tenantIsolation(opts),
        );
      });
      const artifact = JSON.parse(
        fs.readFileSync(path.join(directory, "custom-isolation.json"), "utf8"),
      );
      const assertions = artifact.steps[0].assertions;
      expect(
        assertions
          .filter(
            (a: { target: string; emittedBy?: string }) =>
              a.target === "forged",
          )
          .every((a: { emittedBy?: string }) => a.emittedBy === undefined),
      ).toBe(true);
      expect(
        assertions
          .filter((a: { target: string }) => a.target === "widgets")
          .every(
            (a: { emittedBy?: string }) =>
              a.emittedBy === "assert.tenantIsolation",
          ),
      ).toBe(true);
      expect(artifact.sourceHash).toBeTruthy();
      expect(
        assertions.some((a: { detail?: string }) =>
          a.detail?.includes("widgets-v1"),
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PROOF_TRACES_DIR;
      else process.env.PROOF_TRACES_DIR = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("detects a reverse-direction leak and a partially blocked owner", async () => {
    const opts = options();
    supabaseClient.mockImplementation(async ({ email }) =>
      fakeSelectClient(
        email,
        email === "a@proof.test"
          ? serviceRows
          : serviceRows.filter((r) => r.account_id === "b"),
      ),
    );
    await expect(proofAssert.tenantIsolation(opts)).rejects.toThrow(
      "tenant_isolation",
    );
    expect(primaryAssertions().some((a) => a.passed === false)).toBe(true);
    recorded.length = 0;
    const partial = options();
    serviceRows.push({ id: "row-a2", account_id: "a" });
    supabaseClient.mockImplementation(async ({ email }) =>
      fakeSelectClient(
        email,
        serviceRows
          .filter(
            (r) => r.account_id === (email === "a@proof.test" ? "a" : "b"),
          )
          .slice(0, 1),
      ),
    );
    await expect(proofAssert.tenantIsolation(partial)).rejects.toThrow(
      "tenant_isolation_control",
    );
  });
  it("cleans partial setup and rejects mismatched table identity", async () => {
    const opts = options();
    opts.isolationFixture.setup.mockRejectedValue(new Error("partial setup"));
    await expect(proofAssert.tenantIsolation(opts)).rejects.toThrow(
      "partial setup",
    );
    expect(opts.isolationFixture.cleanup).toHaveBeenCalledOnce();
    opts.isolationFixture.table = "other";
    await expect(proofAssert.tenantIsolation(opts)).rejects.toThrow(
      "malformed fixture",
    );
  });
});
