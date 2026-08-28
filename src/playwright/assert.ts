// Import External Packages
import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIResponse, Page } from "@playwright/test";
// Import Local Imports
import { actAsUser } from "./actAsUser";
import {
  recordAssertion,
  withAssertionProvenance,
  withoutAssertionProvenance,
} from "./trace";
import { seed, type SeedUser, type SeedWorkspace } from "../server/seed";
import {
  isProofFixturePendingError,
  type ProofFixtureContext,
  type ProofFixtureFactory,
} from "../server/fixture";
import { createProofServiceClient } from "../server/service-client";
import { isTransient, TRANSIENT_MAX_ATTEMPTS } from "../server/transient";
import { isAuthRateLimited } from "../server/auth-rate-limit";
import type { AssertionRole } from "../shared/trace-types";
import type { ProofKind } from "../shared/vocabulary";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// assert.tenantIsolation
//
// The core SDK thesis: prove that RLS actually keeps tenant data separated.
//
// The helper:
//   1. Creates two fresh workspaces (orgA, orgB) and one user per workspace
//   2. Runs the caller's `setup()` in orgA so there is data to try to leak
//   3. Counts orgA's rows with the SERVICE ROLE to establish ground truth. Zero
//      rows means the proof would measure nothing, and it fails as vacuous.
//   4. Runs a POSITIVE CONTROL: userA (a member of orgA) must be able to read
//      those rows through RLS. Without this, "userB saw 0 rows" is
//      indistinguishable from a blanket-deny policy, a missing grant, or a
//      typo'd table name — all of which would otherwise record a green
//      tenant-isolation assertion.
//   5. Runs the negative probe: signs in as userB against a direct Supabase
//      client (no browser) and queries `<table>` filtered to orgA.id. If rows
//      come back, RLS is broken — fail with a structured [PROOF_FAIL].
//   6. Repeats 3–5 in reverse (userA against orgB). The reverse direction is
//      SKIPPED WITHOUT RECORDING when the caller only populated orgA, because
//      an empty-org probe is exactly the vacuous pass step 3 exists to reject.
//   7. Optionally: if a `page` is provided, log userB into the browser and
//      navigate somewhere the data would be visible — asserting empty/403
//      UI state as a secondary check.
//   8. Tears down the fixtures (cascades handle most of it).
//
// Ergonomics are the whole point: the caller writes ~3 lines. Any more and
// agents skip the helper, which defeats the SDK. Note that the control in step
// 4 is derived automatically from the seeded fixtures — callers get it for
// free and cannot forget it.
// ---------------------------------------------------------------------------

type RandomSuffix = string;

function randomSuffix(): RandomSuffix {
  return Math.random().toString(36).slice(2, 10);
}

function proofFail(
  category: string,
  expected: string,
  found: string,
  extras: { file?: string; suggestion: string },
): Error {
  return new Error(
    `[PROOF_FAIL] ${category}: expected ${expected}, found ${found}\n` +
      `  file: ${extras.file ?? "src/playwright/assert.ts"}\n` +
      `  suggestion: ${extras.suggestion}`,
  );
}

/**
 * A probe whose request never reached the database has observed nothing, and
 * "nothing" must not be read as a denial.
 *
 * Every write probe below decides its verdict from ground truth — the row did
 * not land, so the policy held — which is exactly what a gateway failure also
 * looks like. The retrying fetch installed on these clients makes that rare;
 * this makes the leftover case loud instead of green. The `*_setup` category
 * follows the SDK convention for "the harness could not establish the conditions
 * to measure".
 */
function failIfInfrastructure(
  error: { message?: string | null; status?: number | null } | null | undefined,
  status: number | undefined,
  setupCategory: string,
  what: string,
): void {
  if (isAuthRateLimited(error, status)) {
    throw proofFail(
      setupCategory.replace(/_setup$/, "_rate_limited"),
      `${what} to receive a database verdict`,
      `HTTP 429/auth budget exhaustion: ${error?.message ?? "rate limited"}`,
      {
        suggestion:
          "This is infrastructure, not an RLS denial. Wait for the auth window to reset or reduce parallel proof workers.",
      },
    );
  }
  if (!isTransient(error, status)) return;
  throw proofFail(
    setupCategory,
    `${what} to reach the database, so that the result means something`,
    `gateway/transport failure after ${TRANSIENT_MAX_ATTEMPTS} attempts: ${error?.message ?? "unknown error"}`,
    {
      suggestion:
        `The request never got an answer from Postgres, so neither "denied" nor "allowed" was observed — ` +
        `reading it as a denial would certify an invariant that nothing exercised. Check that the local Supabase ` +
        `stack is healthy (pnpm exec supabase status) and re-run.`,
    },
  );
}

// Note: the "sign-in as userX and return a fresh SupabaseClient" primitive
// lives in `actAsUser.supabaseClient()` so individual proof specs can use it
// directly for ad-hoc RLS probes. This helper is the primary mechanism for
// tenant isolation checks: it bypasses Playwright entirely.

interface TenantIsolationBaseOptions {
  /**
   * Table to query as userB. RLS on the table is what is being tested.
   * Must be a table governed by a tenant-scoped RLS policy — either
   * workspace-scoped (the canonical pattern uses `get_user_workspace_ids`) or
   * user-scoped (`user_id = auth.uid()`); see `scope`.
   */
  table: string;
  /**
   * What "belongs to one tenant" means for this table:
   *
   *  - `"workspace"` (default) — rows carry a workspace id, and the two tenants
   *    are the seeded orgA / orgB.
   *  - `"user"` — rows carry a user id, and the two tenants are userA / userB.
   *    This is the shape for personal data (notifications, billing records):
   *    the invariant is "another *user* must not read these rows", which is the
   *    same claim as workspace isolation with a different scope column.
   *
   * Tables classified `user_scoped` in `.proof/schema.json` need `"user"`.
   */
  scope?: "workspace" | "user";
  /**
   * Column carrying the scope value. Defaults to `workspace_id` for workspace
   * scope and `user_id` for user scope.
   *
   * Override when the scope lives on the primary key instead of a foreign key —
   * `workspaces` is scoped by its own `id`, and `users` by `id`.
   */
  scopeColumn?: string;
  /**
   * Planner-owned semantic subset that the fixture must materialize.
   *
   * The equality filter is applied together with tenant scope to service-role
   * ground truth, the owner's positive control, and the outsider probe. Put
   * product meaning here (for example `{ status: "published" }`), not in the
   * executor-owned fixture factory: rows outside this subset do not count as
   * evidence for the claim.
   */
  criterion?: {
    description: string;
    where: Record<string, unknown>;
  };
  /**
   * Optional: pass a `page` to verify userB's browser login roundtrip during
   * the probe. The helper stops that document and clears its cookies before
   * deleting the disposable users, so the page is intentionally logged out
   * when this method returns.
   *
   * Product-specific UI assertions need their own fixture lifecycle; they
   * cannot safely reuse credentials after this helper tears them down.
   */
  page?: Page;
  /**
   * Optional: a tag included in seeded workspace/user names so concurrent
   * runs don't collide on error paths where teardown is skipped.
   */
  tag?: string;
  /**
   * Extra column values for the two seeded workspaces, forwarded to
   * `seed.workspace`. The harness itself writes only `name`; a schema whose
   * `workspaces` table requires more (a NOT NULL column without a default)
   * states those values here.
   */
  workspaceColumns?: Record<string, unknown>;
}

function validateTenantIsolationCriterion(
  table: string,
  scopeColumn: string,
  criterion: TenantIsolationBaseOptions["criterion"],
): void {
  if (!criterion) return;

  const invalidReason =
    criterion.description.trim().length === 0
      ? "criterion.description is empty"
      : Object.keys(criterion.where).length === 0
        ? "criterion.where has no equality filters"
        : Object.prototype.hasOwnProperty.call(criterion.where, scopeColumn)
          ? `criterion.where contains the tenant scope column "${scopeColumn}"`
          : null;
  if (!invalidReason) return;

  recordAssertion({
    kind: "tenant_isolation",
    target: table,
    operation: "select",
    passed: false,
    status: "incomplete",
    role: "primary",
    detail: `planner-owned fixture criterion is invalid: ${invalidReason}`,
  });
  throw proofFail(
    "fixture_criterion_invalid",
    "a non-empty semantic equality filter that does not redefine tenant scope",
    invalidReason,
    {
      suggestion:
        `Keep "${scopeColumn}" out of criterion.where; assert.tenantIsolation applies the current side's scope automatically. ` +
        "Use criterion.where only for semantic state such as status, type, or visibility.",
    },
  );
}

/**
 * Tenant fixture source.
 *
 * Inline `setup` remains available for small, settled schemas. A proof written
 * before its schema exists should instead import an explicit factory from
 * `e2e/fixtures/<table>.ts`; that file can export `pendingProofFixture(...)`
 * until the builder knows the final constraints. Supplying both is rejected by
 * the type system so there is one source of fixture truth.
 */
export type TenantIsolationOptions = TenantIsolationBaseOptions &
  (
    | {
        /**
         * Inline setup for an already-known schema. It must create at least one
         * row for side A; side B is optional but required for a bidirectional
         * claim.
         */
        setup: (context: ProofFixtureContext) => Promise<void>;
        fixture?: never;
      }
    | {
        /** Explicit table-owned factory from `e2e/fixtures/<table>.ts`. */
        fixture: ProofFixtureFactory;
        setup?: never;
      }
  );

async function teardown(
  orgA: SeedWorkspace,
  orgB: SeedWorkspace,
  userA: SeedUser,
  userB: SeedUser,
): Promise<void> {
  await Promise.allSettled([
    seed.deleteWorkspace(orgA.id),
    seed.deleteWorkspace(orgB.id),
  ]);
  await Promise.allSettled([
    seed.deleteUser(userA.id),
    seed.deleteUser(userB.id),
  ]);
}

// ---------------------------------------------------------------------------
// assert.authorization
//
// Covers the two dominant "X is NOT allowed to do Y" shapes:
//
//   1. RLS-layer denial — the DB itself rejects (or silently filters) the
//      operation. Used when the invariant is "the RLS policy on table T
//      should block op O for user U against row R."
//
//   2. Action-layer denial — the server action's `withRBAC` or its own
//      role-check rejects the call. Used when the invariant is "action A
//      should return `{ success: false, error: ... }` when invoked by user
//      U." Goes through `actAsUser.invokeAction` → POST /api/proof/invoke-action.
//
// Callers can run either probe or both. RLS probes record `authorization`;
// action probes default to that kind but may name another declared invariant.
// The helper throws on the first probe that *succeeds when it was expected to
// fail* — that's the PROOF_FAIL signal.
//
// Three things a naive version of this helper would grade wrongly, each of which
// has bitten a real proof in this repo:
//
//   - What PostgREST returns is not the verdict. `.select()` adds a RETURNING
//     clause that must satisfy the SELECT policy, so a permitted write can look
//     rejected. Write verdicts come from re-reading state with the service role.
//   - A probe needs something to act on. Against zero matching rows every op
//     looks perfectly enforced (`authorization_vacuous`).
//   - A write probe needs an actor who can SEE what it writes to. Postgres
//     filters the rows an UPDATE/DELETE reaches through its WHERE clause by the
//     SELECT policy, so an actor who cannot read the row matches nothing
//     regardless of write permissions, and the service-role re-read then
//     truthfully reports "unchanged". `requireWriteTargetVisible` records that
//     visibility as a control and fails as `authorization_blind` when it is
//     missing, rather than certifying an invariant nothing exercised.
// ---------------------------------------------------------------------------

type AuthorizationOp = "select" | "insert" | "update" | "delete";

interface RlsProbe {
  /** Table the probe operates against. */
  table: string;
  /** Operation the probe attempts. Each op has distinct "denied" semantics. */
  op: AuthorizationOp;
  /**
   * For `select` / `update` / `delete`: `.eq()` filter applied to the query.
   * Required for update/delete (otherwise the probe has no target row) and
   * typical for select (otherwise it's an unqualified scan).
   */
  filter?: Record<string, unknown>;
  /**
   * For `insert` / `update`: the row payload. Ignored for select/delete.
   */
  payload?: Record<string, unknown>;
  /** Trace target override. Defaults to `table`. */
  target?: string;
}

interface ActionProbe {
  /** Module part of the registry key: `"<module>:<name>"`. */
  module: string;
  /** Action name part of the registry key. Must be in PROOF_ACTION_REGISTRY. */
  name: string;
  /** Forwarded as-is to the action; validated by its own Zod schema. */
  inputParams: Record<string, unknown>;
  /** Optional regex the rejection message must match for a stricter proof. */
  expectedErrorMatch?: RegExp;
  /**
   * Invariant this action probe establishes. Defaults to `authorization`.
   * Use the action's declared withProof invariant (for example
   * `tenant_isolation` or `idempotency`) so coverage matches the evidence.
   */
  kind?: ProofKind;
  /** Trace target override. Defaults to `"<module>:<name>"`. */
  target?: string;
}

interface AuthorizationOptions {
  /**
   * Who is attempting the operation. Must be the role that should be
   * *denied*. Never pass a role the invariant says should succeed —
   * authorization proofs assert rejection, not permission.
   */
  actor: "admin" | "member" | { email: string; password: string };
  /** RLS-layer probe. At least one of `rls` or `action` is required. */
  rls?: RlsProbe;
  /**
   * Action-layer probe. Requires `page` because the action is invoked via
   * the dev server's POST /api/proof/invoke-action route.
   */
  action?: ActionProbe;
  /** Required when `action` is supplied. */
  page?: Page;
}

interface ActionSucceedsOptions {
  /** Who must be able to invoke the action successfully. */
  actor: "admin" | "member" | { email: string; password: string };
  /** Registered action and the exact input used by the control. */
  action: Omit<ActionProbe, "expectedErrorMatch">;
  /** Required because actions are invoked through the proof Route Handler. */
  page: Page;
  /** Assertion category. Defaults to `happy_path`. */
  kind?: ProofKind;
  /**
   * Positive action checks are controls by default: they prove a related
   * refusal was capable of failing, but cannot satisfy a mission on their own.
   */
  role?: AssertionRole;
}

function describeActor(actor: AuthorizationOptions["actor"]): {
  email: string;
  password: string;
  label: string;
} {
  if (typeof actor === "string") {
    // Server-only SEED_* env names — never NEXT_PUBLIC_ (credentials must not
    // be inlined into the client bundle). This code runs in Node (Playwright).
    const emailEnv =
      actor === "admin"
        ? process.env.SEED_ADMIN_EMAIL
        : process.env.SEED_MEMBER_EMAIL;
    const passwordEnv =
      actor === "admin"
        ? process.env.SEED_ADMIN_PASSWORD
        : process.env.SEED_MEMBER_PASSWORD;
    if (!emailEnv || !passwordEnv) {
      const prefix = actor === "admin" ? "SEED_ADMIN" : "SEED_MEMBER";
      throw new Error(
        `[PROOF_FAIL] seed_credentials_missing: ${prefix}_EMAIL and ${prefix}_PASSWORD must be set when using the "${actor}" seed actor`,
      );
    }
    return {
      email: emailEnv,
      password: passwordEnv,
      label: `seed:${actor}`,
    };
  }
  return { email: actor.email, password: actor.password, label: actor.email };
}

/**
 * Apply an equality filter map to a query builder.
 *
 * The cast is contained here on purpose: probes address tables and columns by
 * dynamic name, which the generated Database types cannot express, and letting
 * that inference run through every call site blows the instantiation depth
 * limit.
 */
type EqChain = { eq(column: string, value: unknown): unknown };

function applyEq<T>(query: T, filter: Record<string, unknown>): T {
  let out = query as unknown as EqChain;
  for (const [k, v] of Object.entries(filter)) {
    out = out.eq(k, v) as EqChain;
  }
  return out as unknown as T;
}

/**
 * Count rows matching an exact filter using the service role.
 *
 * This is the ground truth for every write probe. What PostgREST returned to
 * the caller cannot be trusted to answer "did the write land?" — see the long
 * comment in the insert branch of runRlsProbe.
 */
async function countMatchingAsService(
  sb: SupabaseClient,
  table: string,
  filter: Record<string, unknown>,
): Promise<number> {
  const { count, error } = await applyEq(
    sb.from(table).select("*", { count: "exact", head: true }),
    filter,
  );
  if (error) {
    throw proofFail(
      "authorization_setup",
      `to verify the state of "${table}" with the service role`,
      `Supabase error: ${error.message}`,
      {
        suggestion: `The probe cannot confirm whether the write was actually blocked without reading the table as service_role. Check the table name and that SUPABASE_SERVICE_ROLE_KEY is set.`,
      },
    );
  }
  return count ?? 0;
}

/**
 * How many of the probe's target rows the ACTOR can actually read.
 *
 * This is the control that makes a write refusal mean something, and it is not
 * the same question as `countMatchingAsService`. PostgreSQL applies the SELECT
 * policy to the rows an UPDATE or DELETE reaches through its WHERE clause, so an
 * actor who cannot see a row cannot write to it *whatever* the UPDATE/DELETE
 * policy and grants say: the statement matches zero rows and reports success.
 * A before/after comparison then shows nothing changed and the probe records a
 * pass — on a table the actor may in fact be free to rewrite.
 *
 * Concretely: a member probing `audit_logs` (super-admin read only) passes even
 * with UPDATE granted and a `USING (true)` update policy in place. The
 * service-role ground truth cannot catch it, because the service role can see
 * the rows and correctly reports them unchanged.
 *
 * An error is treated as zero visible rows rather than a setup failure: a
 * permission-denied answer IS the observation that the actor cannot read there.
 */
async function countVisibleToActor(
  client: SupabaseClient,
  table: string,
  filter: Record<string, unknown>,
): Promise<number> {
  const { count, error, status } = await applyEq(
    client.from(table).select("*", { count: "exact", head: true }),
    filter,
  );
  failIfInfrastructure(
    error,
    status,
    "authorization_setup",
    `the actor's visibility check on ${table}`,
  );
  if (error) return 0;
  return count ?? 0;
}

/**
 * Refuse to grade a write probe the actor could never have won.
 *
 * Recorded as a `control` assertion either way, so the trace shows the probe was
 * capable of failing instead of leaving a reader to assume it.
 */
async function requireWriteTargetVisible(args: {
  client: SupabaseClient;
  probe: RlsProbe;
  target: string;
  filter: Record<string, unknown>;
  existing: number;
  actorLabel: string;
}): Promise<void> {
  const { client, probe, target, filter, existing, actorLabel } = args;
  const visible = await countVisibleToActor(client, probe.table, filter);

  if (visible > 0) {
    recordAssertion({
      kind: "authorization",
      target,
      operation: "select",
      passed: true,
      role: "control",
      detail: `${actorLabel} can read ${visible} of the ${existing} row(s) matching ${JSON.stringify(filter)} in ${probe.table}, so a refused ${probe.op.toUpperCase()} is distinguishable from one that never reached a row`,
    });
    return;
  }

  recordAssertion({
    kind: "authorization",
    target,
    operation: "select",
    passed: false,
    status: "incomplete",
    role: "control",
    detail: `${actorLabel} cannot read any of the ${existing} row(s) matching ${JSON.stringify(filter)} in ${probe.table}, so its ${probe.op.toUpperCase()} matches zero rows whether or not the operation is permitted`,
  });
  throw proofFail(
    "authorization_blind",
    `${actorLabel} to be able to read at least one of the ${existing} target row(s) in "${probe.table}", so that a refused ${probe.op.toUpperCase()} means the write was rejected`,
    `0 visible row(s) — this probe cannot fail, because PostgreSQL filters the rows an ${probe.op.toUpperCase()} reaches through its WHERE clause by the SELECT policy`,
    {
      suggestion:
        `Point the probe at a row the actor can read, or use an actor who can — for an admin-only table that is the admin, and "not even the actor who can read every row may change one" is usually the stronger claim anyway. ` +
        `If the invariant you actually want is "the actor cannot SEE these rows", use \`op: "select"\` or assert.tenantIsolation, which grade visibility directly.`,
    },
  );
}

async function runRlsProbe(
  probe: RlsProbe,
  actorCreds: { email: string; password: string; label: string },
): Promise<void> {
  const target = probe.target ?? probe.table;
  const client = await actAsUser.supabaseClient({
    email: actorCreds.email,
    password: actorCreds.password,
  });
  // Loosely typed on purpose: probes address tables by dynamic name, which the
  // generated Database types (rightly) reject for literal-union table keys.
  const sb: SupabaseClient = createProofServiceClient();

  if (probe.op === "select") {
    // Ground truth first: "the actor read 0 rows" is only evidence if there was
    // something to read. Against an empty table it is indistinguishable from a
    // working policy, which is the same vacuity trap the write probes guard.
    const existing = await countMatchingAsService(
      sb,
      probe.table,
      probe.filter ?? {},
    );
    if (existing === 0) {
      recordAssertion({
        kind: "authorization",
        target,
        operation: probe.op,
        passed: false,
        status: "incomplete",
        role: "primary",
        detail: `no rows in ${probe.table} matching ${JSON.stringify(probe.filter ?? {})}, so "${actorCreds.label} read 0 rows" proves nothing`,
      });
      throw proofFail(
        "authorization_vacuous",
        `at least one row in "${probe.table}" matching ${JSON.stringify(probe.filter ?? {})} for the select probe to be denied access to`,
        "0 row(s) — there was nothing for the actor to fail to read",
        {
          suggestion: `Seed the fixture row(s) with the service-role client before probing. Reading zero rows from an empty table is not evidence that RLS filtered anything.`,
        },
      );
    }

    let query = client.from(probe.table).select("*");
    for (const [k, v] of Object.entries(probe.filter ?? {})) {
      query = query.eq(k, v);
    }
    const { data, error, status } = await query;
    failIfInfrastructure(
      error,
      status,
      "authorization_setup",
      `the actor's SELECT on ${probe.table}`,
    );
    const rows = data ?? [];

    if (!error && rows.length > 0) {
      recordAssertion({
        kind: "authorization",
        target,
        operation: probe.op,
        passed: false,
        role: "primary",
        detail: `actor ${actorCreds.label} SELECTed ${rows.length} row(s) from ${probe.table}; expected RLS to filter to 0`,
      });
      throw proofFail(
        "authorization",
        `0 rows from ${probe.table} when selected by ${actorCreds.label} with filter ${JSON.stringify(probe.filter ?? {})}`,
        `${rows.length} row(s)`,
        {
          suggestion: `Check SELECT RLS policy on ${probe.table}. The actor should not have read access to these rows.`,
        },
      );
    }

    recordAssertion({
      kind: "authorization",
      target,
      operation: probe.op,
      passed: true,
      role: "primary",
      detail: `${actorCreds.label} SELECT on ${probe.table} returned 0 of the ${existing} row(s) that exist (RLS honored)${error ? `; the query itself errored: ${error.message}` : ""}`,
    });
    return;
  }

  if (probe.op === "insert") {
    if (!probe.payload) {
      throw new Error(
        "[PROOF_FAIL] bad_probe: rls.op='insert' requires `payload`\n" +
          "  file: src/playwright/assert.ts",
      );
    }

    // Deliberately NO .select() here.
    //
    // `.select()` makes PostgREST add a RETURNING clause, and RETURNING must
    // additionally satisfy the table's SELECT policy. On a workspace-scoped
    // table the freshly-inserted row usually CANNOT satisfy it — a policy like
    // `workspace_id IN (SELECT get_user_workspace_ids(auth.uid()))` calls a
    // STABLE function that cannot see the row being written — so the whole
    // statement fails with 42501 even when the INSERT itself was permitted.
    //
    // Trusting that error means reporting a wide-open table as "denied", which
    // is exactly how a self-join hole survived its own regression proof. An
    // attacker simply omits the RETURNING and the row lands.
    const { error, status } = await client
      .from(probe.table)
      .insert(probe.payload);
    failIfInfrastructure(
      error,
      status,
      "authorization_setup",
      `the actor's INSERT on ${probe.table}`,
    );

    // Ground truth: did a row actually land? Only the service role can answer,
    // because the actor may be unable to read what it just wrote.
    const committed = await countMatchingAsService(
      sb,
      probe.table,
      probe.payload,
    );

    if (committed > 0) {
      // Remove the row so teardown and any later probes see a clean table.
      await applyEq(sb.from(probe.table).delete(), probe.payload);

      recordAssertion({
        kind: "authorization",
        target,
        operation: probe.op,
        passed: false,
        role: "primary",
        detail: `actor ${actorCreds.label} INSERT on ${probe.table} COMMITTED ${committed} row(s)${error ? ` even though the API returned "${error.message}"` : ""}; expected RLS/policy denial`,
      });
      throw proofFail(
        "authorization",
        `INSERT on ${probe.table} to be denied for ${actorCreds.label}`,
        error
          ? `the API returned an error ("${error.message}") but a service-role read found ${committed} row(s) committed — the write went through`
          : `insert succeeded (${committed} row(s) committed)`,
        {
          suggestion: `Check INSERT RLS policy and grants on ${probe.table}.`,
        },
      );
    }

    recordAssertion({
      kind: "authorization",
      target,
      operation: probe.op,
      passed: true,
      role: "primary",
      detail: `${actorCreds.label} INSERT on ${probe.table} denied${error ? ` (${error.message})` : ""}; service-role read confirmed 0 row(s) committed`,
    });
    return;
  }

  // update / delete.
  //
  // As with insert, the number of rows PostgREST hands back is not evidence:
  // RETURNING is filtered by the SELECT policy, so a committed write can report
  // zero affected rows. The verdict therefore comes from comparing the table's
  // state before and after using the service role.
  if (!probe.filter) {
    throw new Error(
      `[PROOF_FAIL] bad_probe: rls.op='${probe.op}' requires \`filter\`\n` +
        "  file: src/playwright/assert.ts",
    );
  }

  if (probe.op === "delete") {
    const before = await countMatchingAsService(sb, probe.table, probe.filter);

    // Both guards run BEFORE the delete is attempted: a probe that cannot be
    // graded should not also mutate the fixture it was pointed at.
    //
    // A probe against rows that do not exist proves nothing: 0 → 0 looks
    // identical to a perfectly enforced policy.
    if (before === 0) {
      recordAssertion({
        kind: "authorization",
        target,
        operation: probe.op,
        passed: false,
        role: "primary",
        detail: `no rows in ${probe.table} matched ${JSON.stringify(probe.filter)} before the DELETE probe, so the probe could not have failed`,
      });
      throw proofFail(
        "authorization_vacuous",
        `at least one row in "${probe.table}" matching ${JSON.stringify(probe.filter)} so the DELETE has a target`,
        "0 matching rows before the probe ran",
        {
          suggestion: `Seed the row you expect the actor to be unable to delete before calling assert.authorization.`,
        },
      );
    }

    await requireWriteTargetVisible({
      client,
      probe,
      target,
      filter: probe.filter,
      existing: before,
      actorLabel: actorCreds.label,
    });

    const { error, status } = await applyEq(
      client.from(probe.table).delete(),
      probe.filter,
    );
    failIfInfrastructure(
      error,
      status,
      "authorization_setup",
      `the actor's DELETE on ${probe.table}`,
    );
    const after = await countMatchingAsService(sb, probe.table, probe.filter);

    if (after < before) {
      recordAssertion({
        kind: "authorization",
        target,
        operation: probe.op,
        passed: false,
        role: "primary",
        detail: `actor ${actorCreds.label} DELETE on ${probe.table} removed ${before - after} row(s) (${before} → ${after})${error ? ` even though the API returned "${error.message}"` : ""}; expected none`,
      });
      throw proofFail(
        "authorization",
        `0 rows removed from ${probe.table} by ${actorCreds.label}`,
        `${before - after} row(s) removed (${before} → ${after})`,
        {
          suggestion: `Check the DELETE RLS policy on ${probe.table}.`,
        },
      );
    }

    recordAssertion({
      kind: "authorization",
      target,
      operation: probe.op,
      passed: true,
      role: "primary",
      detail: `${actorCreds.label} DELETE on ${probe.table} removed 0 of ${before} matching row(s)${error ? ` (${error.message})` : ""}; service-role recount confirmed ${after} (RLS honored)`,
    });
    return;
  }

  // update
  if (!probe.payload || Object.keys(probe.payload).length === 0) {
    throw new Error(
      "[PROOF_FAIL] bad_probe: rls.op='update' requires a non-empty `payload`\n" +
        "  file: src/playwright/assert.ts\n" +
        "  suggestion: The payload is both the attempted change and the way the probe verifies whether it was applied.",
    );
  }

  const columns = Object.keys(probe.payload);

  const readTargetRows = async () => {
    const { data, error } = await applyEq(
      sb.from(probe.table).select(columns.join(",")),
      probe.filter as Record<string, unknown>,
    );
    if (error) {
      throw proofFail(
        "authorization_setup",
        `to read ${columns.join(", ")} from "${probe.table}" with the service role`,
        `Supabase error: ${error.message}`,
        {
          suggestion: `The probe compares these columns before and after the update to decide whether the write landed.`,
        },
      );
    }
    return (data ?? []) as unknown as Array<Record<string, unknown>>;
  };

  const rowMatchesPayload = (row: Record<string, unknown>) =>
    columns.every(
      (c) => JSON.stringify(row[c]) === JSON.stringify(probe.payload?.[c]),
    );

  const before = await readTargetRows();

  if (before.length === 0) {
    recordAssertion({
      kind: "authorization",
      target,
      operation: probe.op,
      passed: false,
      role: "primary",
      detail: `no rows in ${probe.table} matched ${JSON.stringify(probe.filter)} before the UPDATE probe, so the probe could not have failed`,
    });
    throw proofFail(
      "authorization_vacuous",
      `at least one row in "${probe.table}" matching ${JSON.stringify(probe.filter)} so the UPDATE has a target`,
      "0 matching rows before the probe ran",
      {
        suggestion: `Seed the row you expect the actor to be unable to modify before calling assert.authorization.`,
      },
    );
  }

  await requireWriteTargetVisible({
    client,
    probe,
    target,
    filter: probe.filter,
    existing: before.length,
    actorLabel: actorCreds.label,
  });

  const { error, status } = await applyEq(
    client.from(probe.table).update(probe.payload),
    probe.filter,
  );
  failIfInfrastructure(
    error,
    status,
    "authorization_setup",
    `the actor's UPDATE on ${probe.table}`,
  );
  const after = await readTargetRows();

  const beforeApplied = before.filter(rowMatchesPayload).length;
  const afterApplied = after.filter(rowMatchesPayload).length;

  if (afterApplied > beforeApplied) {
    recordAssertion({
      kind: "authorization",
      target,
      operation: probe.op,
      passed: false,
      role: "primary",
      detail: `actor ${actorCreds.label} UPDATE on ${probe.table} applied ${columns.join(", ")} to ${afterApplied - beforeApplied} row(s)${error ? ` even though the API returned "${error.message}"` : ""}; expected the write to be rejected`,
    });
    throw proofFail(
      "authorization",
      `${columns.join(", ")} on ${probe.table} to be unchanged for ${actorCreds.label}`,
      `${afterApplied - beforeApplied} row(s) now hold the attempted value(s) ${JSON.stringify(probe.payload)}`,
      {
        suggestion: `Check the UPDATE RLS policy and any column guard on ${probe.table}.`,
      },
    );
  }

  recordAssertion({
    kind: "authorization",
    target,
    operation: probe.op,
    passed: true,
    role: "primary",
    detail: `${actorCreds.label} UPDATE on ${probe.table} left ${columns.join(", ")} unchanged across ${before.length} targeted row(s)${error ? ` (${error.message})` : ""}; verified by service-role re-read (RLS honored)`,
  });
}

/**
 * Outcome of a single-direction isolation probe.
 *
 *   - `proved`         — the isolated org held at least one row, its own member
 *                        could read those rows, and the outsider could not.
 *   - `skipped_no_data` — the isolated org held no rows, so there was nothing
 *                        to leak. NOTHING is recorded: a probe with no data
 *                        cannot prove isolation, and recording a pass here is
 *                        precisely the false-confidence bug this guards.
 */
type IsolationProbeOutcome = "proved" | "skipped_no_data";

/**
 * Count the rows belonging to one tenant using the service role, bypassing RLS.
 * This is the ground truth the probe is measured against.
 */
async function countRowsAsService(
  sb: SupabaseClient,
  table: string,
  filter: Record<string, unknown>,
): Promise<number> {
  const { count, error } = await applyEq(
    sb.from(table).select("*", { count: "exact", head: true }),
    filter,
  );

  if (error) {
    throw proofFail(
      "tenant_isolation_setup",
      `to count rows in "${table}" with the service role to establish ground truth`,
      `Supabase error: ${error.message}`,
      {
        suggestion: `Confirm "${table}" exists and supports the planner-owned filter ${JSON.stringify(filter)}. Tenant isolation cannot be measured without first knowing how many matching rows are actually there.`,
      },
    );
  }
  return count ?? 0;
}

async function probeTenantIsolation(args: {
  table: string;
  viewer: SeedUser;
  viewerLabel: string;
  /** Owner of the isolated rows; drives the positive control. */
  owner: SeedUser;
  ownerLabel: string;
  /** Column + value identifying the tenant whose rows must stay hidden. */
  scopeColumn: string;
  scopeValue: string;
  scopeLabel: string;
  criterion?: TenantIsolationBaseOptions["criterion"];
  /** The canonical RLS pattern for this scope, quoted in failure suggestions. */
  scopePattern: string;
  /** Service-role client, used only to establish ground truth. */
  sb: SupabaseClient;
}): Promise<IsolationProbeOutcome> {
  const {
    table,
    viewer,
    viewerLabel,
    owner,
    ownerLabel,
    scopeColumn,
    scopeValue,
    scopeLabel,
    criterion,
    scopePattern,
    sb,
  } = args;
  const filter = {
    [scopeColumn]: scopeValue,
    ...(criterion?.where ?? {}),
  };
  const criterionDetail = criterion
    ? ` matching planner criterion "${criterion.description}" (${JSON.stringify(criterion.where)})`
    : "";

  // ---- Ground truth: is there anything here to leak? ----------------------
  // Without this, "the outsider saw 0 rows" is unfalsifiable — an empty table
  // produces exactly the same observation as perfectly-enforced RLS.
  const actualRowCount = await countRowsAsService(sb, table, filter);
  if (actualRowCount === 0) {
    return "skipped_no_data";
  }

  // ---- Positive control: can the org's OWN member read those rows? --------
  // This is what separates "RLS hid the rows from an outsider" from "nobody
  // can read this table at all" (blanket-deny policy, missing grant, typo'd
  // table name). Both make the negative probe below return zero rows; only the
  // first one is tenant isolation.
  const ownerClient = await actAsUser.supabaseClient({
    email: owner.email,
    password: owner.password,
  });
  const {
    data: ownRows,
    error: ownError,
    status: ownStatus,
  } = await applyEq(ownerClient.from(table).select("*"), filter);
  failIfInfrastructure(
    ownError,
    ownStatus,
    "tenant_isolation_setup",
    `the owner's control SELECT on ${table}`,
  );

  if (ownError || (ownRows?.length ?? 0) === 0) {
    recordAssertion({
      kind: "tenant_isolation",
      target: table,
      operation: "select",
      passed: false,
      role: "control",
      detail: `positive control FAILED: ${ownerLabel} (owner of ${scopeLabel}) read ${ownRows?.length ?? 0} of ${actualRowCount} row(s) in ${table}${criterionDetail}${ownError ? `; error: ${ownError.message}` : ""}`,
    });
    throw proofFail(
      "tenant_isolation_control",
      `${ownerLabel} to read the ${actualRowCount} row(s) that exist in "${table}" for ${scopeLabel}${criterionDetail}`,
      ownError
        ? `Supabase error: ${ownError.message}`
        : `0 row(s) — their own data is invisible to them`,
      {
        suggestion:
          `The negative probe would have "passed" here for the wrong reason: if the owner cannot read their own rows, ` +
          `then an outsider seeing 0 rows proves nothing. Check the SELECT policy/grant on "${table}" — the canonical pattern for ` +
          `this scope is ${scopePattern}. If this table is intentionally service-role-only, it is not a ` +
          `tenant-isolation target: use assert.authorization instead.`,
      },
    );
  }

  recordAssertion({
    kind: "tenant_isolation",
    target: table,
    operation: "select",
    passed: true,
    role: "control",
    detail: `${ownerLabel} read ${ownRows?.length ?? 0} of ${actualRowCount} row(s) in ${table} for ${scopeLabel}${criterionDetail} — the probe can observe these rows, so a leak would be detected`,
  });

  // ---- Negative probe: the outsider must see none of them -----------------
  const client = await actAsUser.supabaseClient({
    email: viewer.email,
    password: viewer.password,
  });

  const {
    data: leakedRows,
    error: queryError,
    status: queryStatus,
  } = await applyEq(client.from(table).select("*"), filter);
  failIfInfrastructure(
    queryError,
    queryStatus,
    "tenant_isolation_setup",
    `the outsider's SELECT on ${table}`,
  );

  if (queryError) {
    recordAssertion({
      kind: "tenant_isolation",
      target: table,
      operation: "select",
      passed: false,
      role: "primary",
      detail: `${viewerLabel} select on ${table} scoped to ${scopeLabel}${criterionDetail} failed: ${queryError.message}`,
    });
    throw proofFail(
      "tenant_isolation",
      `query against ${table} as ${viewerLabel} to succeed (possibly returning 0 rows)`,
      `Supabase error: ${queryError.message}`,
      {
        suggestion: `Verify "${table}" has a ${scopeColumn} column and a SELECT grant for authenticated users. Tenant isolation cannot be proven if the query itself is denied at the grant level.`,
      },
    );
  }

  if (leakedRows && leakedRows.length > 0) {
    const sampleIds = leakedRows
      .slice(0, 3)
      .map((r: { id?: string | number }) => r.id ?? "?")
      .join(", ");

    recordAssertion({
      kind: "tenant_isolation",
      target: table,
      operation: "select",
      passed: false,
      role: "primary",
      detail: `${viewerLabel} saw ${leakedRows.length} row(s) in ${table} belonging to ${scopeLabel}${criterionDetail} (sample ids: ${sampleIds})`,
    });
    throw proofFail(
      "tenant_isolation",
      `0 rows in "${table}" for ${viewerLabel} filtered to ${JSON.stringify(filter)}`,
      `${leakedRows.length} row(s) (sample ids: ${sampleIds})`,
      {
        suggestion: `Inspect the RLS policy on "${table}". The canonical pattern for this scope is ${scopePattern}.`,
      },
    );
  }

  recordAssertion({
    kind: "tenant_isolation",
    target: table,
    operation: "select",
    passed: true,
    role: "primary",
    detail: `${viewerLabel} saw 0 of the ${actualRowCount} row(s) that exist in ${table} for ${scopeLabel}${criterionDetail}, which ${ownerLabel} can read (RLS honored)`,
  });

  return "proved";
}

async function runActionProbe(
  probe: ActionProbe,
  actorCreds: { email: string; password: string; label: string },
  page: Page,
): Promise<void> {
  const target = probe.target ?? `${probe.module}:${probe.name}`;
  const kind = probe.kind ?? "authorization";
  const result = await actAsUser.invokeAction(page, {
    as:
      actorCreds.label === "seed:admin"
        ? "admin"
        : actorCreds.label === "seed:member"
          ? "member"
          : { email: actorCreds.email, password: actorCreds.password },
    module: probe.module,
    action: probe.name,
    inputParams: probe.inputParams,
  });

  if (result.success) {
    recordAssertion({
      kind,
      target,
      operation: "invoke",
      passed: false,
      role: "primary",
      detail: `actor ${actorCreds.label} successfully invoked ${target}; expected action-layer rejection`,
    });
    throw proofFail(
      kind,
      `action "${target}" to return { success: false } for ${actorCreds.label}`,
      "action returned { success: true }",
      {
        suggestion: `Check withRBAC / role-check logic inside ${probe.module}/${probe.name}. The action should reject the actor.`,
      },
    );
  }

  if (
    probe.expectedErrorMatch &&
    !probe.expectedErrorMatch.test(result.error)
  ) {
    recordAssertion({
      kind,
      target,
      operation: "invoke",
      passed: false,
      role: "primary",
      detail: `action "${target}" rejected ${actorCreds.label} but with unexpected message: ${result.error}`,
    });
    throw proofFail(
      kind,
      `rejection message matching ${probe.expectedErrorMatch}`,
      `error: "${result.error}"`,
      {
        suggestion: `The action rejected the caller (good) but not for the expected reason. Confirm the proof is asserting on the right invariant.`,
      },
    );
  }

  recordAssertion({
    kind,
    target,
    operation: "invoke",
    passed: true,
    role: "primary",
    detail: `action "${target}" rejected ${actorCreds.label} with: ${result.error}`,
  });
}

async function runSuccessfulActionProbe<TData>(
  opts: ActionSucceedsOptions,
): Promise<TData> {
  const actorCreds = describeActor(opts.actor);
  const target =
    opts.action.target ?? `${opts.action.module}:${opts.action.name}`;
  const kind = opts.kind ?? opts.action.kind ?? "happy_path";
  const role = opts.role ?? "control";
  const result = await actAsUser.invokeAction<TData>(opts.page, {
    as:
      actorCreds.label === "seed:admin"
        ? "admin"
        : actorCreds.label === "seed:member"
          ? "member"
          : { email: actorCreds.email, password: actorCreds.password },
    module: opts.action.module,
    action: opts.action.name,
    inputParams: opts.action.inputParams,
  });

  if (!result.success) {
    recordAssertion({
      kind,
      target,
      operation: "invoke",
      passed: false,
      role,
      detail: `action "${target}" rejected ${actorCreds.label}; expected success: ${result.error}`,
    });
    throw proofFail(
      kind,
      `action "${target}" to return { success: true } for ${actorCreds.label}`,
      `action returned { success: false, error: "${result.error}" }`,
      {
        suggestion: `A refusal proof needs a working positive path. Check the action registry, validation input, and the permissions for ${actorCreds.label}.`,
      },
    );
  }

  recordAssertion({
    kind,
    target,
    operation: "invoke",
    passed: true,
    role,
    detail: `action "${target}" succeeded for ${actorCreds.label}`,
  });
  return result.data;
}

const assertMethods = {
  /**
   * Prove that workspace-scoped data in `table` is invisible to members of a
   * different workspace. See file header for full semantics.
   *
   * Records two assertions per proved direction: a `control` showing the org's
   * own member CAN read the rows, and the `primary` showing the outsider
   * cannot. Only the `primary` can satisfy a mission's `trace_must_prove`
   * entry.
   *
   * Fails rather than passing vacuously when `setup()` leaves orgA empty.
   */
  async tenantIsolation(opts: TenantIsolationOptions): Promise<void> {
    const { table, page } = opts;
    const tag = opts.tag ?? randomSuffix();
    const scope = opts.scope ?? "workspace";
    const scopeColumn =
      opts.scopeColumn ?? (scope === "user" ? "user_id" : "workspace_id");
    validateTenantIsolationCriterion(table, scopeColumn, opts.criterion);

    const orgA = await seed.workspace(`Proof OrgA ${tag}`, {
      columns: opts.workspaceColumns,
    });
    const orgB = await seed.workspace(`Proof OrgB ${tag}`, {
      columns: opts.workspaceColumns,
    });

    const userA = await seed.user({
      email: `proof-a-${tag}@proof.test`,
      password: `ProofPass!${tag}1`,
      workspace: orgA,
      role: "owner",
    });
    const userB = await seed.user({
      email: `proof-b-${tag}@proof.test`,
      password: `ProofPass!${tag}1`,
      workspace: orgB,
      role: "owner",
    });

    const sb = createProofServiceClient();

    // Which column carries the tenant, and what each side's value is. Personal
    // data is scoped by user, workspace data by workspace; `workspaces` and
    // `users` carry their scope on the primary key, hence the override.
    const scopePattern =
      scope === "user"
        ? "user_id = auth.uid()"
        : "workspace_id IN (SELECT get_user_workspace_ids(auth.uid()))";
    const sideA = scope === "user" ? userA.id : orgA.id;
    const sideB = scope === "user" ? userB.id : orgB.id;
    const labelA = scope === "user" ? "user A's rows" : "orgA";
    const labelB = scope === "user" ? "user B's rows" : "orgB";

    try {
      const fixtureContext: ProofFixtureContext = {
        orgA,
        orgB,
        userA,
        userB,
        sb,
      };

      if (opts.fixture && opts.fixture.table !== table) {
        recordAssertion({
          kind: "tenant_isolation",
          target: table,
          operation: "select",
          passed: false,
          status: "incomplete",
          role: "primary",
          detail: `fixture for "${opts.fixture.table}" cannot seed proof target "${table}"`,
        });
        throw proofFail(
          "fixture_factory_mismatch",
          `the imported fixture factory to declare table "${table}"`,
          `factory declares "${opts.fixture.table}"`,
          {
            file: `e2e/fixtures/${table}.ts`,
            suggestion:
              `Import the factory owned by "${table}", or correct its table declaration. ` +
              `A copied factory must not silently seed one table while the proof probes another.`,
          },
        );
      }

      try {
        // Fixture factories and setup callbacks are executor-authored code
        // running inside this helper. Provenance is suspended around them so a
        // hostile callback calling recordAssertion cannot inherit this
        // helper's trusted stamp.
        if (opts.fixture) {
          await withoutAssertionProvenance(() =>
            opts.fixture!.create(fixtureContext),
          );
        } else {
          await withoutAssertionProvenance(() => opts.setup!(fixtureContext));
        }
      } catch (error) {
        if (!isProofFixturePendingError(error)) throw error;

        recordAssertion({
          kind: "tenant_isolation",
          target: table,
          operation: "select",
          passed: false,
          status: "incomplete",
          role: "primary",
          detail: `fixture factory incomplete: ${error.reason}`,
        });
        throw proofFail(
          error.code,
          `a completed fixture factory for "${table}"`,
          error.reason,
          {
            file: `e2e/fixtures/${table}.ts`,
            suggestion:
              `Replace pendingProofFixture(...) with defineProofFixture(...), using values valid for the final schema. ` +
              `Resolve required foreign keys from seeded/existing rows and honor NOT NULL, CHECK, domain, and enum constraints. ` +
              `Do not weaken a product constraint to make the proof easier to seed.`,
          },
        );
      }

      // ---- Primary direction: orgA holds the data, userB must not see it ---
      // `setup()` is contracted to populate orgA, so an empty orgA here means
      // the proof is measuring nothing. Fail loudly rather than record the
      // vacuous pass — a green "tenant isolation holds" on a table with no
      // rows is worse than no proof at all, because it gets believed.
      const forward = await probeTenantIsolation({
        table,
        viewer: userB,
        viewerLabel: "user B",
        owner: userA,
        ownerLabel: "user A",
        scopeColumn,
        scopeValue: sideA,
        scopeLabel: labelA,
        criterion: opts.criterion,
        scopePattern,
        sb,
      });

      if (forward === "skipped_no_data") {
        recordAssertion({
          kind: "tenant_isolation",
          target: table,
          operation: "select",
          passed: false,
          status: "incomplete",
          role: "primary",
          detail:
            `fixture setup created 0 rows in "${table}" where ${scopeColumn} = ${sideA}` +
            (opts.criterion
              ? ` matching planner criterion "${opts.criterion.description}" (${JSON.stringify(opts.criterion.where)})`
              : ""),
        });
        throw proofFail(
          "tenant_isolation_vacuous",
          `setup() to create at least one "${table}" row for ${labelA}${opts.criterion ? ` matching planner criterion "${opts.criterion.description}"` : ""} so there is something for user B to fail to see`,
          `0 rows in "${table}" matching ${JSON.stringify({
            [scopeColumn]: sideA,
            ...(opts.criterion?.where ?? {}),
          })} after setup() returned`,
          {
            suggestion:
              `An empty table cannot demonstrate isolation: user B seeing 0 rows would be indistinguishable from working RLS. ` +
              `Insert the fixture row(s) in e2e/fixtures/${table}.ts (or the inline setup) using the provided service-role client (\`sb\`), and make sure they carry ` +
              `${scopeColumn} = ${sideA}${opts.criterion ? ` and satisfy planner criterion "${opts.criterion.description}" (${JSON.stringify(opts.criterion.where)})` : ""}.`,
          },
        );
      }

      // ---- Reverse direction: only meaningful if the caller populated orgB -
      // Legitimately skipped for the common single-org setup. Skipping records
      // NOTHING, which is the point: the old behaviour recorded a passing
      // assertion for this probe even against an empty orgB, and that pass was
      // enough on its own to satisfy a mission's trace requirement.
      const reverse = await probeTenantIsolation({
        table,
        viewer: userA,
        viewerLabel: "user A",
        owner: userB,
        ownerLabel: "user B",
        scopeColumn,
        scopeValue: sideB,
        scopeLabel: labelB,
        criterion: opts.criterion,
        scopePattern,
        sb,
      });

      if (reverse === "skipped_no_data") {
        // Recorded, not just logged: a direction that was never measured is a
        // real state, and a consumer reading the trace must be able to see it
        // rather than inferring it from one fewer passing assertion.
        recordAssertion({
          kind: "tenant_isolation",
          target: table,
          operation: "select",
          passed: false,
          status: "skipped",
          role: "primary",
          detail:
            `reverse direction (A→B) not measured: setup() left ${labelB}${opts.criterion ? ` without rows matching planner criterion "${opts.criterion.description}"` : " empty"}, so there is nothing for user A to fail to see. ` +
            `Populate both sides in setup() to prove isolation in both directions.`,
        });
        console.log(
          `[proof] tenantIsolation(${table}): reverse probe (A→B) skipped — setup() left ${labelB}${opts.criterion ? ` without rows matching criterion "${opts.criterion.description}"` : " empty"}, ` +
            `so there is nothing for user A to fail to see. The A→B direction is unproven; ` +
            `populate it in setup() if you need it proven in both directions.`,
        );
      }

      // ---- Optional check: secondary UI assertion -----------------------
      if (page) {
        await actAsUser.loginAs(page, userB.email, userB.password);
        // Intentionally no product-specific navigation. The login itself
        // asserts the auth cookie roundtrip; finally logs out this page before
        // teardown deletes the disposable auth users.
      }
    } finally {
      try {
        if (page) {
          await actAsUser.logout(page);
        }
      } finally {
        await teardown(orgA, orgB, userA, userB);
      }
    }
  },

  /**
   * Prove that an operation is rejected when performed by an unauthorized
   * actor. Can probe either the RLS layer (direct Supabase client), the
   * action layer (via POST /api/proof/invoke-action), or both.
   *
   * RLS probes record `kind: "authorization"`. Action probes default to the
   * same kind but may set `action.kind` to the withProof invariant they
   * establish. The helper throws on the first probe that SUCCEEDS when it was
   * expected to fail — that's the PROOF_FAIL signal.
   *
   * Caller is responsible for seeding any fixture rows needed; this helper
   * creates no users or workspaces on its own.
   *
   * @example
   * // Action-layer: member cannot remove admin
   * await assert.authorization({
   *   actor: { email: member.email, password: member.password },
   *   action: {
   *     module: "workspace",
   *     name: "removeMember",
   *     inputParams: { formData: { workspaceId, memberId } },
   *     expectedErrorMatch: /permission|unauthorized/i,
   *   },
   *   page,
   * });
   *
   * @example
   * // RLS-layer: member cannot DELETE admin's workspace_members row
   * await assert.authorization({
   *   actor: { email: member.email, password: member.password },
   *   rls: {
   *     table: "workspace_members",
   *     op: "delete",
   *     filter: { user_id: admin.id, workspace_id: orgA.id },
   *   },
   * });
   */
  async authorization(opts: AuthorizationOptions): Promise<void> {
    if (!opts.rls && !opts.action) {
      throw new Error(
        "[PROOF_FAIL] bad_options: assert.authorization requires at least one of `rls` or `action`\n" +
          "  file: src/playwright/assert.ts\n" +
          "  suggestion: Pass an `rls` probe for DB-layer denial or an `action` probe for action-layer denial (or both).",
      );
    }
    if (opts.action && !opts.page) {
      throw new Error(
        "[PROOF_FAIL] bad_options: assert.authorization's `action` probe requires a Playwright `page`\n" +
          "  file: src/playwright/assert.ts\n" +
          "  suggestion: Destructure `page` from the test callback and pass it in.",
      );
    }

    const actorCreds = describeActor(opts.actor);

    if (opts.rls) {
      await runRlsProbe(opts.rls, actorCreds);
    }
    if (opts.action && opts.page) {
      await runActionProbe(opts.action, actorCreds, opts.page);
    }
  },

  /**
   * Prove that a registered action succeeds for an actor who should be allowed.
   *
   * This is the positive-control companion to action-level refusal probes.
   * Assertions default to `role: "control"`, so a working happy path cannot
   * satisfy the mission's primary requirement by itself. Override `role` only
   * when success is the primary invariant being proved.
   *
   * Returns the action's data so the caller can make domain-specific checks.
   */
  async actionSucceeds<TData = unknown>(
    opts: ActionSucceedsOptions,
  ): Promise<TData> {
    return runSuccessfulActionProbe<TData>(opts);
  },

  /**
   * Assert on an HTTP response from a page route. Streaming-RSC aware: when
   * only body markers (`mustContain` / `mustNotContain`) are provided, the
   * helper does NOT check the status code — crucial for routes guarded by
   * a server component's `notFound()` call that Next.js can only signal via
   * an embedded NOT_FOUND marker because headers were already committed as
   * 200 by `loading.tsx`. See
   * [proof-authoring.mdc](mdc:.cursor/rules/proof-authoring.mdc) for the
   * streaming-RSC gotcha in full.
   *
   * Defaults:
   *   - method: "GET"
   *   - maxRedirects: 0 (intentional — silent redirect-following has caused
   *     real false passes on auth-gated pages)
   *
   * Records one TraceAssertion with caller-provided `kind` and `target`.
   * Returns the raw Playwright APIResponse so callers can run additional
   * custom checks (headers, etc.) after.
   *
   * @example
   * // Streaming-RSC page: assert body markers, not status code
   * await assert.httpResponse({
   *   page,
   *   path: "/secret-admin",
   *   as: "member",
   *   kind: "authorization",
   *   target: "/secret-admin",
   *   expect: {
   *     mustContain: [/Sorry, we could not find this page/i],
   *     mustNotContain: [/Here you can see what.?s happening on your platform/i],
   *   },
   * });
   *
   * @example
   * // Flat API route: assert status
   * await assert.httpResponse({
   *   page,
   *   path: "/api/public-ping",
   *   kind: "happy_path",
   *   expect: { status: 200 },
   * });
   */
  async httpResponse(opts: {
    page: Page;
    path: string;
    kind: ProofKind;
    target?: string;
    /**
     * Evidential role of the recorded assertion. Defaults to `"primary"`.
     * Pass `"control"` when this request exists only to show the probe could
     * have failed — e.g. "the admin CAN reach the page a member was refused" —
     * so it cannot satisfy a mission's `trace_must_prove` entry by itself.
     */
    role?: AssertionRole;
    as?: "admin" | "member" | { email: string; password: string };
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    expect: {
      status?: number;
      mustContain?: RegExp[];
      mustNotContain?: RegExp[];
    };
  }): Promise<APIResponse> {
    const target = opts.target ?? opts.path;
    const method = opts.method ?? "GET";
    const role: AssertionRole = opts.role ?? "primary";

    if (opts.as !== undefined) {
      if (typeof opts.as === "string") {
        await actAsUser.login(opts.page, opts.as);
      } else {
        await actAsUser.loginAs(opts.page, opts.as.email, opts.as.password);
      }
    }

    const requestCtx = opts.page.request;
    const requestOpts = { maxRedirects: 0 } as const;

    let response: APIResponse;
    switch (method) {
      case "GET":
        response = await requestCtx.get(opts.path, requestOpts);
        break;
      case "POST":
        response = await requestCtx.post(opts.path, requestOpts);
        break;
      case "PUT":
        response = await requestCtx.put(opts.path, requestOpts);
        break;
      case "PATCH":
        response = await requestCtx.patch(opts.path, requestOpts);
        break;
      case "DELETE":
        response = await requestCtx.delete(opts.path, requestOpts);
        break;
    }

    const status = response.status();
    let body: string | null = null;

    const failures: string[] = [];

    if (opts.expect.status !== undefined && status !== opts.expect.status) {
      failures.push(
        `status mismatch: expected ${opts.expect.status}, got ${status}`,
      );
    }

    if (
      (opts.expect.mustContain && opts.expect.mustContain.length > 0) ||
      (opts.expect.mustNotContain && opts.expect.mustNotContain.length > 0)
    ) {
      body = await response.text();

      for (const re of opts.expect.mustContain ?? []) {
        if (!re.test(body)) {
          failures.push(`mustContain not matched: ${re}`);
        }
      }
      for (const re of opts.expect.mustNotContain ?? []) {
        if (re.test(body)) {
          failures.push(
            `mustNotContain matched (should have been absent): ${re}`,
          );
        }
      }
    }

    if (failures.length > 0) {
      recordAssertion({
        kind: opts.kind,
        target,
        operation: "request",
        passed: false,
        role,
        detail: `${method} ${opts.path} -> ${status}; failures: ${failures.join("; ")}`,
      });
      throw new Error(
        `[PROOF_FAIL] ${opts.kind}: response from ${method} ${opts.path} did not match expectations\n` +
          `  status: ${status}\n` +
          `  failures:\n${failures.map((f) => `    - ${f}`).join("\n")}\n` +
          `  file: src/playwright/assert.ts\n` +
          `  suggestion: ${opts.expect.mustContain || opts.expect.mustNotContain ? "For streaming RSC routes, assert on body markers rather than status. See .cursor/rules/proof-authoring.mdc." : "Check the route handler or page component and confirm the expected response shape."}`,
      );
    }

    recordAssertion({
      kind: opts.kind,
      target,
      operation: "request",
      passed: true,
      role,
      detail: `${method} ${opts.path} -> ${status}${opts.expect.mustContain || opts.expect.mustNotContain ? " (body markers matched)" : ""}`,
    });

    return response;
  },
};

/**
 * Wrap a helper so every assertion it records carries `emittedBy: name`.
 *
 * The stamp travels through `withAssertionProvenance`'s AsyncLocalStorage, so
 * it reaches the shared probe internals (`runRlsProbe`, `runActionProbe`, ...)
 * without threading a name through thirty call sites — and it cannot be set
 * from spec code, because the public `recordAssertion` strips caller-supplied
 * `emittedBy` and `withAssertionProvenance` is not exported from the package
 * entry point.
 */
function withHelperProvenance<TArgs extends unknown[], TResult>(
  name: string,
  fn: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withAssertionProvenance(name, () => fn(...args));
}

export const assert = {
  tenantIsolation: withHelperProvenance(
    "assert.tenantIsolation",
    assertMethods.tenantIsolation,
  ),
  authorization: withHelperProvenance(
    "assert.authorization",
    assertMethods.authorization,
  ),
  // Cast preserves the <TData> generic that the wrapper's closed-over
  // signature would otherwise collapse to `unknown`.
  actionSucceeds: withHelperProvenance(
    "assert.actionSucceeds",
    assertMethods.actionSucceeds,
  ) as typeof assertMethods.actionSucceeds,
  httpResponse: withHelperProvenance(
    "assert.httpResponse",
    assertMethods.httpResponse,
  ),
};
