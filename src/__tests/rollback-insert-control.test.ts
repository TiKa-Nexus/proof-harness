import { expect, it, vi } from "vitest";
import type { Client } from "pg";
import { rollbackInsertControl, withLocalPostgres } from "../node/postgres";
function client(fail?: string) {
  const query = vi.fn(async (sql: string) => {
    if (sql === fail) throw new Error("simulated database failure");
    return {
      rows: sql.includes("current_user") ? [{ role: "service_role" }] : [],
      rowCount: 1,
      command: sql === "ROLLBACK" ? "ROLLBACK" : "OK",
    };
  });
  return { query, pg: { query } as unknown as Client };
}
it("checks deferred constraints and rolls back, without DELETE or COMMIT", async () => {
  const { pg, query } = client();
  await rollbackInsertControl(pg, {
    table: "audit_logs",
    role: "service_role",
    payload: { action: "sample" },
  });
  const sql = query.mock.calls.map((c) => c[0]);
  expect(sql).toContain("SET CONSTRAINTS ALL IMMEDIATE");
  expect(sql.at(-1)).toBe("ROLLBACK");
  expect(sql.some((s) => /DELETE|COMMIT/.test(s))).toBe(false);
});
it("rolls back and rejects a deferred constraint failure", async () => {
  const { pg, query } = client("SET CONSTRAINTS ALL IMMEDIATE");
  await expect(
    rollbackInsertControl(pg, {
      table: "audit_logs",
      role: "service_role",
      payload: { action: "sample" },
    }),
  ).rejects.toThrow("simulated database failure");
  expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
});
it("never reports success when rollback fails", async () => {
  const { pg } = client("ROLLBACK");
  await expect(
    rollbackInsertControl(pg, {
      table: "audit_logs",
      role: "service_role",
      payload: { action: "sample" },
    }),
  ).rejects.toThrow("rollback failed");
});
it("refuses remote or redirected database connections before executing callbacks", async () => {
  const callback = vi.fn();
  await expect(
    withLocalPostgres("postgres://user:secret@example.com/test", callback),
  ).rejects.toThrow("loopback");
  await expect(
    withLocalPostgres(
      "postgres://user:secret@localhost/test?host=example.com",
      callback,
    ),
  ).rejects.toThrow("URL options");
  expect(callback).not.toHaveBeenCalled();
});
