// Import External Packages
// Import Local Imports
import { createProofServiceClient } from "./service-client";
import { isTransient, TRANSIENT_MAX_ATTEMPTS } from "./transient";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// seed.workspace / seed.user
//
// Fixture helpers used by `.proof.ts` specs and by `assert.tenantIsolation`
// to set up isolated test data. They bypass the business-logic pipeline on
// purpose: creating fixtures should not exercise the very actions we are
// trying to verify. Instead we insert directly via the service-role client.
//
// Both helpers are idempotent on upsert conflicts is NOT implemented; callers
// are responsible for passing unique names/emails (`assert.tenantIsolation`
// uses a short random suffix).
// ---------------------------------------------------------------------------

export interface SeedWorkspace {
  id: string;
  name: string;
  ownerId: string | null;
}

export interface SeedUser {
  id: string;
  email: string;
  password: string;
  workspaceId: string;
  role: "owner" | "admin" | "member" | "viewer";
  /**
   * `workspace_members.id` for this user's membership row in `workspaceId`.
   * Needed by proofs that invoke actions keyed on the membership (e.g.
   * `removeMember` takes `memberId = workspace_members.id`, not user_id).
   */
  membershipId: string;
}

function failProof(
  category: string,
  expected: string,
  found: string,
  suggestion = `Check that Supabase is running (pnpm exec supabase status) and that SUPABASE_SECRET_KEY is set in .env.local.`,
): never {
  throw new Error(
    `[PROOF_FAIL] ${category}: expected ${expected}, found ${found}\n` +
      `  file: src/server/seed.ts\n` +
      `  suggestion: ${suggestion}`,
  );
}

/**
 * Fixture setup that failed because the gateway never answered is reported as
 * infrastructure. Otherwise the operator reads "expected a workspace row to be
 * created" and goes looking for a broken migration.
 */
function failSeed(
  category: string,
  expected: string,
  found: string,
  error: { message?: string | null; status?: number | null } | null | undefined,
  status?: number,
): never {
  if (isTransient(error, status)) {
    failProof(
      `${category}_transient`,
      expected,
      `${found} — still failing after ${TRANSIENT_MAX_ATTEMPTS} attempts`,
      `This is a gateway/transport failure, not a schema problem: the request never reached Postgres. ` +
        `Check that the local Supabase stack is healthy (pnpm exec supabase status) and is not restarting mid-run.`,
    );
  }
  failProof(category, expected, found);
}

/**
 * Wait until `public.users` has a row for the given `userId`.
 *
 * `supabase.auth.admin.createUser` creates a row in `auth.users`, which fires
 * the `handle_new_user` trigger that inserts into `public.users`. Postgres
 * runs the trigger inside the same transaction as the INSERT, so the row
 * exists the moment the admin API's HTTP call returns — in theory.
 *
 * In practice the admin API occasionally returns before the post-commit
 * visibility window has settled, and the very next `workspace_members`
 * INSERT fails its FK to `public.users(id)`. This poll closes that window
 * deterministically: short, bounded, ~500ms worst case. A real failure
 * still surfaces with a structured [PROOF_FAIL] so the race is not masked.
 *
 * Note: `workspace_members.user_id` FKs to `public.users(id)`, NOT
 * `auth.users`. The value is the same UUID because `handle_new_user`
 * copies it, but the FK target matters if future migrations ever split
 * them.
 */
async function waitForPublicUser(
  sb: ReturnType<typeof createProofServiceClient>,
  userId: string,
  email: string,
): Promise<void> {
  const maxAttempts = 10;
  const delayMs = 50;
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await sb
      .from("users")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    if (data) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  failProof(
    "seed_user_trigger",
    `public.users row for ${email} (id ${userId}) within ${maxAttempts * delayMs}ms`,
    "row still missing — the handle_new_user trigger did not materialize the public.users mirror row",
  );
}

export const seed = {
  /**
   * Create a workspace with no owner. Use `seed.user({ workspace, role: "owner" })`
   * afterwards to attach an owner. Returns the inserted row.
   *
   * Bypasses RLS via the service-role client, so it works even when no user
   * is authenticated.
   */
  async workspace(name: string): Promise<SeedWorkspace> {
    const sb = createProofServiceClient();

    const { data, error, status } = await sb
      .from("workspaces")
      .insert({
        name,
        type: "team",
      })
      .select("id, name, owner_id")
      .single();

    if (error || !data) {
      failSeed(
        "seed_workspace",
        "a workspace row to be created",
        `insert error: ${error?.message ?? "no row returned"}`,
        error,
        status,
      );
    }

    return {
      id: data.id,
      name: data.name,
      ownerId: data.owner_id,
    };
  },

  /**
   * Create an auth user with the given credentials and attach them to the
   * provided workspace with the given role. Relies on the `handle_new_user`
   * trigger to mirror the row into `public.users` automatically.
   */
  async user(opts: {
    email: string;
    password: string;
    workspace: SeedWorkspace;
    role: "owner" | "admin" | "member" | "viewer";
  }): Promise<SeedUser> {
    const sb = createProofServiceClient();

    const { data: userData, error: createErr } = await sb.auth.admin.createUser(
      {
        email: opts.email,
        password: opts.password,
        email_confirm: true,
      },
    );

    if (createErr || !userData?.user) {
      failSeed(
        "seed_user_auth",
        `auth user to be created for ${opts.email}`,
        `admin.createUser error: ${createErr?.message ?? "no user returned"}`,
        createErr,
      );
    }

    const userId = userData.user.id;

    // `workspace_members.user_id` references `public.users(id)`, not
    // `auth.users`. The `handle_new_user` trigger mirrors the row on
    // `auth.users` INSERT; poll briefly to rule out any post-commit
    // visibility race before the FK insert below.
    await waitForPublicUser(sb, userId, opts.email);

    const {
      data: memberRow,
      error: memberErr,
      status: memberStatus,
    } = await sb
      .from("workspace_members")
      .insert({
        workspace_id: opts.workspace.id,
        user_id: userId,
        role: opts.role,
      })
      .select("id")
      .single();

    if (memberErr || !memberRow) {
      failSeed(
        "seed_user_membership",
        `workspace_members row for user ${opts.email} in workspace ${opts.workspace.id}`,
        `insert error: ${memberErr?.message ?? "no row returned"}`,
        memberErr,
        memberStatus,
      );
    }

    return {
      id: userId,
      email: opts.email,
      password: opts.password,
      workspaceId: opts.workspace.id,
      role: opts.role,
      membershipId: memberRow.id,
    };
  },

  /**
   * Delete a workspace and cascade-clean its members. Used by helpers for
   * teardown. Safe to call on a workspace that no longer exists.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const sb = createProofServiceClient();
    await sb.from("workspaces").delete().eq("id", workspaceId);
  },

  /**
   * Delete an auth user (cascades to public.users and workspace_members via
   * the schema's ON DELETE CASCADE). Safe to call if the user no longer
   * exists.
   */
  async deleteUser(userId: string): Promise<void> {
    const sb = createProofServiceClient();
    await sb.auth.admin.deleteUser(userId);
  },
};
