// Explicit local integration: PROOF_DATABASE_URL=... node tests/postgres-integration.mjs
// Creates and drops one empty database; never changes the supplied database.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  withLocalPostgres,
  readPostgresCatalog,
  rollbackInsertControl,
} from "../dist/node.js";
import { diffSchema } from "../cli/engines/proof_drift.mjs";

const connection = process.env.PROOF_DATABASE_URL;
if (!connection)
  throw new Error(
    "Set PROOF_DATABASE_URL to a disposable local PostgreSQL stack with CREATEDB",
  );
const database = `proof_integration_${crypto.randomUUID().replaceAll("-", "")}`;
const target = new URL(connection);
target.pathname = `/${database}`;
await withLocalPostgres(connection, async (admin) => {
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  try {
    await withLocalPostgres(target.href, async (client) => {
      const role = (await client.query("SELECT current_user AS role")).rows[0]
        .role;
      await client.query(`
        CREATE TABLE parents (id int PRIMARY KEY);
        INSERT INTO parents VALUES (1);
        CREATE TABLE entries (id int PRIMARY KEY, parent_id int REFERENCES parents DEFERRABLE INITIALLY DEFERRED, action text NOT NULL CHECK (action <> 'invalid'));
        CREATE FUNCTION no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append only'; END $$;
        CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON entries FOR EACH ROW EXECUTE FUNCTION no_delete();
        ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
        CREATE POLICY entries_read ON entries AS RESTRICTIVE FOR SELECT TO PUBLIC USING (parent_id = 1);
      `);
      const base = { tables: await readPostgresCatalog(client) };
      assert.equal(
        base.tables.find((t) => t.name === "entries").policies[0].mode,
        "RESTRICTIVE",
      );
      await rollbackInsertControl(client, {
        table: "entries",
        role,
        payload: { id: 1, parent_id: 1, action: "valid" },
      });
      assert.equal(
        (await client.query("SELECT count(*)::int AS count FROM entries"))
          .rows[0].count,
        0,
      );
      for (const payload of [
        { id: 2, parent_id: 1, action: "invalid" },
        { id: 3, parent_id: 999, action: "valid" },
      ]) {
        await assert.rejects(
          rollbackInsertControl(client, { table: "entries", role, payload }),
        );
        assert.equal(
          (await client.query("SELECT count(*)::int AS count FROM entries"))
            .rows[0].count,
          0,
        );
      }
      await client.query(
        "ALTER TABLE entries ADD COLUMN added text; ALTER TABLE entries FORCE ROW LEVEL SECURITY; ALTER POLICY entries_read ON entries USING (true)",
      );
      const changed = diffSchema(base, {
        tables: await readPostgresCatalog(client),
      });
      assert.deepEqual(changed.find((e) => e.key === "entries").facets, [
        "rls_classification_changed",
        "columns_added",
        "policies_changed",
      ]);
      await client.query(
        "ALTER TABLE entries DROP COLUMN added; DROP POLICY entries_read ON entries",
      );
      const dropped = await readPostgresCatalog(client);
      assert.equal(
        dropped.find((t) => t.name === "entries").columns.includes("added"),
        false,
      );
      assert.equal(
        dropped.find((t) => t.name === "entries").policies.length,
        0,
      );
      console.log(
        "PostgreSQL integration passed: append-only rollback, immediate/deferred rejection, ALTER/DROP, policy expression/mode, forced RLS",
      );
    });
  } finally {
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  }
});
