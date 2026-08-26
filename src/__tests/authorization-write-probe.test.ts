// Import External Packages
import { beforeEach, describe, expect, it, vi } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// The hole these tests close.
//
// PostgreSQL filters the rows an UPDATE or DELETE reaches through its WHERE
// clause by the table's SELECT policy. An actor who cannot see a row therefore
// cannot write to it no matter what the write policy and grants allow: the
// statement matches nothing and reports success. `assert.authorization` decides
// write verdicts by re-reading state with the service role, which sees the row
// and correctly reports it unchanged — so the probe passed while measuring
// nothing, on a table the actor may have been free to rewrite.
//
// Found in the field: a member probing `audit_logs` (super-admin read only)
// passed even with UPDATE granted and a `USING (true)` policy in place.
//
// Both clients are faked here. The point is the decision logic, and a guard that
// only runs against a healthy local Supabase is a guard nobody watches fail.
// ---------------------------------------------------------------------------

type Op = "select" | "insert" | "update" | "delete";

interface QueryCall {
  client: "actor" | "service";
  table: string;
  op: Op;
  filter: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

interface QueryResult {
  data?: unknown[] | null;
  count?: number | null;
  error?: { message: string } | null;
  status?: number;
}

type Responder = (call: QueryCall) => QueryResult;

const calls: QueryCall[] = [];
const recorded: Array<Record<string, unknown>> = [];

/**
 * Minimal PostgREST-shaped builder: chainable `.eq()`, awaitable at the end.
 */
function fakeClient(which: "actor" | "service", responder: Responder) {
  const build = (table: string, op: Op, payload?: Record<string, unknown>) => {
    const call: QueryCall = { client: which, table, op, filter: {}, payload };
    const chain = {
      eq(column: string, value: unknown) {
        call.filter[column] = value;
        return chain;
      },
      select() {
        return chain;
      },
      then(resolve: (r: QueryResult) => unknown) {
        calls.push(call);
        const result = responder(call);
        return Promise.resolve(resolve({ status: 200, ...result }));
      },
    };
    return chain;
  };

  return {
    from(table: string) {
      return {
        select: () => build(table, "select"),
        insert: (payload: Record<string, unknown>) =>
          build(table, "insert", payload),
        update: (payload: Record<string, unknown>) =>
          build(table, "update", payload),
        delete: () => build(table, "delete"),
      };
    },
  };
}

let actorResponder: Responder = () => ({});
let serviceResponder: Responder = () => ({});

vi.mock("../playwright/actAsUser", () => ({
  actAsUser: {
    supabaseClient: async () => fakeClient("actor", (c) => actorResponder(c)),
  },
}));

vi.mock("../server/service-client", () => ({
  createProofServiceClient: () =>
    fakeClient("service", (c) => serviceResponder(c)),
}));

vi.mock("../playwright/trace", () => ({
  recordAssertion: (a: Record<string, unknown>) => recorded.push(a),
  withAssertionProvenance: (_helper: string, fn: () => Promise<unknown>) =>
    fn(),
  withoutAssertionProvenance: (fn: () => Promise<unknown>) => fn(),
}));

const { assert } = await import("../playwright/assert");

const ROW = { id: "row-1", outcome: "success" };

beforeEach(() => {
  process.env.SEED_ADMIN_EMAIL = "admin@example.test";
  process.env.SEED_ADMIN_PASSWORD = "admin-test-password";
  process.env.SEED_MEMBER_EMAIL = "member@example.test";
  process.env.SEED_MEMBER_PASSWORD = "member-test-password";
  calls.length = 0;
  recorded.length = 0;
  actorResponder = () => ({});
  serviceResponder = () => ({});
});

function control() {
  return recorded.find((a) => a.role === "control");
}

function primary() {
  return recorded.find((a) => a.role === "primary");
}

describe("assert.authorization — write probes require a visible target", () => {
  it("refuses to grade an UPDATE the actor could never have reached", async () => {
    // The service role sees the row; the actor sees none of it. Under the old
    // logic this recorded a pass.
    serviceResponder = () => ({ data: [ROW], count: 1 });
    actorResponder = () => ({ data: [], count: 0 });

    await expect(
      assert.authorization({
        actor: "member",
        rls: {
          table: "audit_logs",
          op: "update",
          filter: { id: "row-1" },
          payload: { outcome: "failure" },
        },
      }),
    ).rejects.toThrow(/authorization_blind/);

    expect(control()).toMatchObject({
      role: "control",
      passed: false,
      status: "incomplete",
    });
    // No pass may be recorded for a claim that was never measured.
    expect(primary()).toBeUndefined();
    // And the fixture must be left alone: a probe that cannot be graded should
    // not also mutate the row it was pointed at.
    expect(calls.some((c) => c.client === "actor" && c.op === "update")).toBe(
      false,
    );
  });

  it("refuses to grade a DELETE the actor could never have reached", async () => {
    serviceResponder = () => ({ data: [ROW], count: 1 });
    actorResponder = () => ({ data: [], count: 0 });

    await expect(
      assert.authorization({
        actor: "member",
        rls: { table: "audit_logs", op: "delete", filter: { id: "row-1" } },
      }),
    ).rejects.toThrow(/authorization_blind/);

    expect(calls.some((c) => c.client === "actor" && c.op === "delete")).toBe(
      false,
    );
  });

  it("reads a permission error on the visibility check as 'not visible'", async () => {
    // A permission-denied answer is the observation, not a setup failure — the
    // actor demonstrably cannot read there.
    serviceResponder = () => ({ data: [ROW], count: 1 });
    actorResponder = () => ({
      error: { message: "permission denied for table audit_logs" },
      status: 403,
    });

    await expect(
      assert.authorization({
        actor: "member",
        rls: { table: "audit_logs", op: "delete", filter: { id: "row-1" } },
      }),
    ).rejects.toThrow(/authorization_blind/);
  });

  it("still fails as vacuous when the target row does not exist at all", async () => {
    // Ordering matters: "nothing to write to" is a different diagnosis from
    // "you cannot see what you are writing to", and the first should win.
    serviceResponder = () => ({ data: [], count: 0 });
    actorResponder = () => ({ data: [], count: 0 });

    await expect(
      assert.authorization({
        actor: "member",
        rls: { table: "audit_logs", op: "delete", filter: { id: "missing" } },
      }),
    ).rejects.toThrow(/authorization_vacuous/);
  });
});

describe("assert.authorization — write verdicts once the target is visible", () => {
  it("passes when a visible row survives the actor's UPDATE", async () => {
    serviceResponder = () => ({ data: [ROW], count: 1 });
    actorResponder = (call) =>
      call.op === "select"
        ? { data: [ROW], count: 1 }
        : { error: { message: "permission denied" }, status: 403 };

    await assert.authorization({
      actor: "admin",
      rls: {
        table: "audit_logs",
        op: "update",
        filter: { id: "row-1" },
        payload: { outcome: "failure" },
      },
    });

    expect(control()).toMatchObject({ role: "control", passed: true });
    expect(primary()).toMatchObject({ role: "primary", passed: true });
  });

  it("fails when the actor's UPDATE actually lands", async () => {
    // The regression guard for the primary verdict: the service-role re-read now
    // shows the attempted value, so the write was permitted.
    let applied = false;
    serviceResponder = () => ({
      data: [applied ? { ...ROW, outcome: "failure" } : ROW],
      count: 1,
    });
    actorResponder = (call) => {
      if (call.op === "select") return { data: [ROW], count: 1 };
      applied = true;
      return {};
    };

    await expect(
      assert.authorization({
        actor: "admin",
        rls: {
          table: "audit_logs",
          op: "update",
          filter: { id: "row-1" },
          payload: { outcome: "failure" },
        },
      }),
    ).rejects.toThrow(/\[PROOF_FAIL\] authorization:/);
  });

  it("passes when a visible row survives the actor's DELETE", async () => {
    serviceResponder = () => ({ data: [ROW], count: 1 });
    actorResponder = (call) =>
      call.op === "select"
        ? { data: [ROW], count: 1 }
        : { error: { message: "permission denied" }, status: 403 };

    await assert.authorization({
      actor: "admin",
      rls: { table: "audit_logs", op: "delete", filter: { id: "row-1" } },
    });

    expect(control()).toMatchObject({ role: "control", passed: true });
    expect(primary()).toMatchObject({ role: "primary", passed: true });
  });

  it("leaves INSERT probes alone — an insert reads no existing row", async () => {
    // Nothing to be blind to, so no control is required and none is recorded.
    serviceResponder = () => ({ data: [], count: 0 });
    actorResponder = () => ({
      error: { message: "new row violates row-level security policy" },
      status: 403,
    });

    await assert.authorization({
      actor: "member",
      rls: {
        table: "audit_logs",
        op: "insert",
        payload: { action: "forged" },
      },
    });

    expect(control()).toBeUndefined();
    expect(primary()).toMatchObject({ role: "primary", passed: true });
  });
});
