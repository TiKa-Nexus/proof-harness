function policyIndicatesWorkspace(policy) {
  const body = `${policy.using} ${policy.check}`.toLowerCase();
  if (body.includes("get_user_workspace_ids(")) return true;
  if (
    /workspace_id\s+in\s*\(\s*select\s+workspace_id\s+from\s+workspace_members/i.test(
      `${policy.using} ${policy.check}`,
    )
  ) {
    return true;
  }
  return false;
}

function policyIndicatesUser(policy) {
  const body = `${policy.using} ${policy.check}`;
  // user_id = auth.uid() OR auth.uid() = user_id OR owner/created_by variants
  const patterns = [
    /\b(user_id|owner_id|created_by|invited_by)\s*=\s*\(?\s*(select\s+)?auth\.uid\(\)/i,
    /\bauth\.uid\(\)\s*=\s*(user_id|owner_id|created_by|invited_by)\b/i,
    /\(\s*select\s+auth\.uid\(\)\s*\)\s*=\s*(user_id|owner_id|created_by|invited_by)\b/i,
    /\b(user_id|owner_id|created_by|invited_by)\s*=\s*\(\s*select\s+auth\.uid\(\)\s*\)/i,
  ];
  return patterns.some((re) => re.test(body));
}

function policyIsPublicRead(policy) {
  if (policy.command !== "SELECT") return false;
  const body = policy.using.trim().toLowerCase();
  return body === "true";
}

export function classifyTable(policies) {
  // No policies at all → admin_only (assumes RLS-enabled Supabase table
  // without authenticated access).
  if (policies.length === 0) return "admin_only";

  // A policy with no TO clause defaults to `TO public` in Postgres, so
  // treat an empty `roles` list as implicit public (i.e. authenticated
  // users are subject to it). This matches the common
  // `CREATE POLICY foo ON t FOR SELECT USING (...)` pattern.
  const isAuthFacing = (p) =>
    p.roles.length === 0 ||
    p.roles.some((r) => r === "authenticated" || r === "public");
  const authPolicies = policies.filter(isAuthFacing);
  const serviceOnly =
    authPolicies.length === 0 &&
    policies.length > 0 &&
    policies.every(
      (p) => p.roles.length === 1 && p.roles[0] === "service_role",
    );

  if (serviceOnly) return "service_only";

  // Check workspace first (most specific).
  if (authPolicies.some(policyIndicatesWorkspace)) return "workspace_scoped";
  if (authPolicies.some(policyIndicatesUser)) return "user_scoped";

  // public_read: every authenticated-accessible policy is SELECT with
  // USING (true). (Don't classify as public_read if any write policy
  // targets authenticated, that's a different pattern.)
  const readPolicies = authPolicies.filter(
    (p) => p.command === "SELECT" || p.command === "ALL",
  );
  if (
    readPolicies.length > 0 &&
    readPolicies.every(policyIsPublicRead) &&
    authPolicies.every((p) => p.command === "SELECT")
  ) {
    return "public_read";
  }

  if (authPolicies.length === 0) return "admin_only";

  return "unclassified";
}
