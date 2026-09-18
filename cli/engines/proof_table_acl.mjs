// Canonical relevant ACL state, not effective has_table_privilege booleans.
const lit = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const ident = (value) => '"' + String(value).replaceAll('"', '""') + '"';
export function tableAclSnapshotSql(subject) {
  return `WITH target AS (SELECT oid, relowner, relacl FROM pg_class WHERE oid = ${lit(subject.table)}::regclass), entries AS (
    SELECT NULL::text AS column_name, a.* FROM target t, LATERAL aclexplode(coalesce(t.relacl,acldefault('r',t.relowner))) a
    UNION ALL
    SELECT c.attname::text, a.* FROM target t JOIN pg_attribute c ON c.attrelid=t.oid AND c.attnum>0 AND NOT c.attisdropped,
      LATERAL aclexplode(c.attacl) a
  ) SELECT json_build_object('version',1,'owner',(SELECT pg_get_userbyid(relowner) FROM target),
    'entries',coalesce((SELECT json_agg(json_build_object('column',column_name,'grantor',pg_get_userbyid(grantor),
      'grantee',CASE WHEN grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END,'grantable',is_grantable)
      ORDER BY column_name NULLS FIRST,grantor,grantee,is_grantable)
      FROM entries WHERE privilege_type=${lit(subject.privilege.toUpperCase())}), '[]'::json))::text`;
}
export function validateTableAcl(snapshot) {
  const value = JSON.parse(snapshot);
  if (
    value?.version !== 1 ||
    typeof value.owner !== "string" ||
    !Array.isArray(value.entries) ||
    value.entries.some(
      (e) =>
        !(e.column === null || typeof e.column === "string") ||
        typeof e.grantee !== "string" ||
        typeof e.grantable !== "boolean" ||
        e.grantor !== value.owner,
    )
  )
    throw new Error(
      "[PROOF_FAIL] mutation_unassessed: table ACL requires versioned owner-issued grants; delegated grant graphs need a dedicated mutation",
    );
  return value;
}
export function restoreTableAclSql(subject, snapshot) {
  const value = validateTableAcl(snapshot);
  const privilege = subject.privilege.toUpperCase();
  if (
    ![
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ].includes(privilege)
  )
    throw new Error("unsupported table privilege");
  const role = subject.role === "PUBLIC" ? "PUBLIC" : ident(subject.role);
  // Revoking a table privilege also removes this role's column grants. Restore
  // those explicitly, preserving grant options. No CASCADE: unexpected dependent
  // grants abort instead of destroying state not represented by the snapshot.
  const sql = [`REVOKE ${privilege} ON ${subject.table} FROM ${role};`];
  for (const entry of value.entries.filter((e) => e.grantee === subject.role)) {
    sql.push(
      `GRANT ${privilege}${entry.column === null ? "" : ` (${ident(entry.column)})`} ON ${subject.table} TO ${role}${entry.grantable ? " WITH GRANT OPTION" : ""};`,
    );
  }
  return sql.join("\n");
}
