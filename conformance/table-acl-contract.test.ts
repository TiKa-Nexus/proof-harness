import fs from "node:fs";
import { expect, it } from "vitest";
import {
  restoreTableAclSql,
  validateTableAcl,
} from "../cli/engines/proof_table_acl.mjs";
const snapshot = fs.readFileSync(
  "proof-consumer-fixtures/mutations/table-acl/snapshot.json",
  "utf8",
);
it("restores column grants with their exact grant options", () => {
  const sql = restoreTableAclSql(
    { table: "public.users", role: "authenticated", privilege: "UPDATE" },
    snapshot,
  );
  expect(sql).toContain(
    'GRANT UPDATE ("full_name") ON public.users TO "authenticated" WITH GRANT OPTION;',
  );
  expect(sql).toContain(
    'GRANT UPDATE ("username") ON public.users TO "authenticated";',
  );
  expect(sql).not.toContain("GRANT UPDATE ON");
  expect(sql).not.toContain("CASCADE");
});
it("rejects old Boolean recovery journals and delegated grant graphs", () => {
  expect(() => validateTableAcl("f")).toThrow();
  expect(() =>
    validateTableAcl(
      snapshot.replace('"grantor":"postgres"', '"grantor":"other"'),
    ),
  ).toThrow("delegated");
});
