import { loadProofConfig } from "../../cli/config.mjs";
import { rollbackInsertControl, withLocalPostgres } from "../node/postgres";

/** Configuration is a protected trust input, never a proof-authored callback. */
export async function configuredInsertControl(
  table: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const config = await loadProofConfig();
  const control = config.insertControl as Record<string, unknown> | null;
  if (!control) return false;
  if (
    control.mode !== "rollback" ||
    typeof control.databaseUrlEnv !== "string" ||
    !control.databaseUrlEnv ||
    typeof control.role !== "string" ||
    !control.role ||
    typeof control.supabaseUrl !== "string"
  )
    throw new Error(
      "[PROOF_FAIL] authorization_incomplete: invalid insertControl configuration",
    );
  // Bind the trusted direct connection configuration to the REST endpoint used by the probe.
  if (
    new URL(control.supabaseUrl).origin !==
    new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin
  )
    throw new Error(
      "[PROOF_FAIL] authorization_incomplete: INSERT control belongs to a different Supabase endpoint",
    );
  const role = control.role;
  const connection = process.env[control.databaseUrlEnv];
  if (!connection)
    throw new Error(
      `[PROOF_FAIL] authorization_incomplete: missing ${control.databaseUrlEnv} for INSERT control`,
    );
  try {
    await withLocalPostgres(connection, (client) =>
      rollbackInsertControl(client, { table, payload, role }),
    );
  } catch (error) {
    throw new Error(
      `[PROOF_FAIL] authorization_incomplete: rollback INSERT control failed: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
  return true;
}
