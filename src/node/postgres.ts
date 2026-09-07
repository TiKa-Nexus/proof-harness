import { Client, type ClientConfig } from "pg";

/** Direct database access is restricted to explicitly configured local test stacks. */
export async function withLocalPostgres<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      "[PROOF_FAIL] unsafe_database: invalid PostgreSQL connection URL",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      "[PROOF_FAIL] unsafe_database: direct proof connections require a loopback PostgreSQL host",
    );
  // Reject connection-string query options that could redirect the actual host.
  if ([...url.searchParams.keys()].some((key) => !["sslmode"].includes(key)))
    throw new Error(
      "[PROOF_FAIL] unsafe_database: unsupported PostgreSQL URL options",
    );
  const config: ClientConfig = {
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
    application_name: "proof-harness",
  };
  const client = new Client(config);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function quotePostgresIdentifier(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("invalid PostgreSQL identifier");
  return `"${value.replace(/"/g, '""')}"`;
}

export interface PostgresCatalogPolicy {
  name: string;
  command: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
  roles: string[];
  mode: "PERMISSIVE" | "RESTRICTIVE";
  using: string;
  check: string;
}

export interface PostgresCatalogTable {
  schema: string;
  name: string;
  columns: string[];
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: PostgresCatalogPolicy[];
}

/** One statement takes a consistent snapshot of columns, RLS and complete policies. */
export async function readPostgresCatalog(
  client: Client,
  schemas: readonly string[] = ["public"],
) {
  if (!schemas.length || schemas.some((s) => typeof s !== "string" || !s))
    throw new Error("catalog schemas must be nonempty names");
  const result = await client.query<PostgresCatalogTable>(
    `
    SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname) AS columns,
      coalesce((SELECT json_agg(json_build_object(
        'name',p.polname,'command',CASE p.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END,
        'roles',ARRAY(SELECT CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1),
        'mode',CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
        'using',coalesce(pg_get_expr(p.polqual,p.polrelid),''),
        'check',coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')
      ) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::json) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname = ANY($1::text[]) ORDER BY n.nspname,c.relname`,
    [schemas],
  );
  return result.rows;
}

/** Exercise constraints as the intended role, then roll back on the same connection. */
export async function rollbackInsertControl(
  client: Client,
  options: {
    schema?: string;
    table: string;
    role: string;
    payload: Record<string, unknown>;
  },
) {
  const { table, role, payload, schema = "public" } = options;
  const columns = Object.keys(payload);
  if (!columns.length || columns.some((c) => payload[c] === undefined))
    throw new Error(
      "[PROOF_FAIL] authorization_incomplete: INSERT control needs a JSON payload with defined columns",
    );
  const target = `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table)}`;
  const selected = columns.map(quotePostgresIdentifier).join(", ");
  let began = false;
  let failure: unknown;
  let failed = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query(`SET LOCAL ROLE ${quotePostgresIdentifier(role)}`);
    const current = await client.query("SELECT current_user AS role");
    if (current.rows[0]?.role !== role)
      throw new Error("control did not assume its configured role");
    // JSON conversion follows PostgreSQL column types; omitted columns retain defaults.
    const inserted = await client.query(
      `INSERT INTO ${target} (${selected}) SELECT ${selected} FROM jsonb_populate_record(NULL::${target}, $1::jsonb)`,
      [JSON.stringify(payload)],
    );
    if (inserted.rowCount !== 1)
      throw new Error("control INSERT did not insert exactly one row");
    // A payload rejected by a deferred FK or constraint trigger is not valid evidence.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (began) {
    try {
      const rollback = await client.query("ROLLBACK");
      if (rollback.command !== "ROLLBACK")
        throw new Error("rollback was not acknowledged");
    } catch (error) {
      throw new AggregateError(
        failed ? [failure, error] : [error],
        "[PROOF_FAIL] authorization_incomplete: INSERT control rollback failed",
      );
    }
  }
  if (failed) throw failure;
}
