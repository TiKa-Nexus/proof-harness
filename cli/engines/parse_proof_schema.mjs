#!/usr/bin/env node
// ---------------------------------------------------------------------------
// parse_proof_schema.mjs
//
// v1 proof SDK migration parser.
//
// Reads every `.sql` file in `supabase/migrations/` (the aggregated source
// of truth that Supabase actually runs) and emits `.proof/schema.json` with:
//
//   { schemaVersion: 1, tables: [
//       { name, columns, policies, rls_classification, files } ] }
//
// Classification rules (order-sensitive — first match wins per policy,
// aggregated per table):
//
//   1. Policy body references `get_user_workspace_ids(`
//        OR `workspace_id IN (SELECT workspace_id FROM workspace_members`
//      → workspace_scoped
//   2. Policy body references `auth.uid() = user_id`, `user_id = auth.uid()`,
//      `owner_id = auth.uid()`, or `auth.uid() = owner_id`
//      → user_scoped
//   3. Policy TO clause is exactly `service_role` (no authenticated policies)
//      → service_only
//   4. Policy is `FOR SELECT` with `USING (true)` to authenticated/public/anon
//      and no workspace/user-scoped policies exist
//      → public_read
//   5. No policies target authenticated at all (only service_role or none)
//      → admin_only
//   6. Anything else → unclassified (surfaced for human review)
//
// Shallow SQL parsing is intentional: paren-balancing only, no AST, no
// semantic understanding. v2 can upgrade to a real PG parser. The output
// shape here is the stable contract.
//
// Deterministic output (sorted tables + columns + policies, no timestamp)
// so `git diff --exit-code` is a meaningful freshness gate in CI.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const MIGRATIONS_DIR = CONFIG.roots.migrations;
const OUTPUT_PATH = CONFIG.artifacts.schema;

// ---------------------------------------------------------------------------
// SQL preprocessing
// ---------------------------------------------------------------------------

export function stripSqlComments(sql) {
  // Remove `/* block comments */` first, then `-- line` comments. Don't try
  // to be clever about strings containing `--`; migrations avoid that.
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/--[^\n]*/g, "");
  return out;
}

function readAllMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => path.join(MIGRATIONS_DIR, e.name))
    .sort();
  return files.map((file) => ({
    file,
    sql: stripSqlComments(fs.readFileSync(file, "utf8")),
  }));
}

// ---------------------------------------------------------------------------
// Paren-balanced block extraction
// ---------------------------------------------------------------------------

/**
 * Given a source string and an index pointing at an opening `(`, return
 * the index of the matching closing `)` at the same depth, or -1 if the
 * block is unbalanced. Ignores parens inside single-quoted strings.
 */
function findMatchingParen(src, openIdx) {
  if (src[openIdx] !== "(") return -1;
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "'") {
        if (src[i + 1] === "'")
          i++; // escaped single quote
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a paren-balanced SQL list on top-level commas only.
 */
function splitTopLevelCommas(body) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === "'") {
        if (body[i + 1] === "'") i++;
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// CREATE TABLE parsing
// ---------------------------------------------------------------------------

export const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(/gi;

// Keywords that start a table-level constraint rather than a column definition.
const CONSTRAINT_KEYWORDS = new Set([
  "PRIMARY",
  "FOREIGN",
  "UNIQUE",
  "CHECK",
  "CONSTRAINT",
  "EXCLUDE",
  "LIKE",
]);

function parseColumns(body) {
  const columns = [];
  for (const seg of splitTopLevelCommas(body)) {
    const firstWord = seg.split(/\s|\(/)[0].toUpperCase();
    if (CONSTRAINT_KEYWORDS.has(firstWord)) continue;
    const match = seg.match(/^"?(\w+)"?/);
    if (!match) continue;
    const name = match[1];
    // Skip anything that still looks like a keyword (defensive).
    if (CONSTRAINT_KEYWORDS.has(name.toUpperCase())) continue;
    columns.push(name);
  }
  // Dedupe while preserving first-seen order.
  return [...new Set(columns)];
}

/**
 * Table names created by one `.sql` file.
 *
 * Exported so anything that needs to know which tables a module owns shares
 * this parser rather than growing its own. A second `CREATE TABLE` regex is a
 * second thing to get wrong, and the interesting failure is silent: a pattern
 * that misses `create table "public"."x"` reports a module as owning no tables
 * at all, which reads exactly like a module that genuinely owns none.
 */
export function tableNamesIn(sql) {
  const names = new Set();
  const stripped = stripSqlComments(sql);
  CREATE_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_TABLE_RE.exec(stripped)) !== null) names.add(m[1]);
  return [...names].sort();
}

function extractTables(sql, sourceFile) {
  const tables = [];
  CREATE_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_TABLE_RE.exec(sql)) !== null) {
    const name = m[1];
    const openParen = sql.indexOf("(", m.index + m[0].length - 1);
    if (openParen < 0) continue;
    const closeParen = findMatchingParen(sql, openParen);
    if (closeParen < 0) continue;
    const body = sql.slice(openParen + 1, closeParen);
    tables.push({
      name,
      columns: parseColumns(body),
      sourceFile,
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// CREATE POLICY parsing
// ---------------------------------------------------------------------------

// Matches the policy header; body is captured separately by scanning forward.
const CREATE_POLICY_RE =
  /CREATE\s+POLICY\s+(?:"([^"]+)"|(\w+))\s+ON\s+(?:"?public"?\.)?"?(\w+)"?\s+([\s\S]*?)(?=;)/gi;

function parsePolicies(sql, sourceFile) {
  const policies = [];
  CREATE_POLICY_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_POLICY_RE.exec(sql)) !== null) {
    const policyName = m[1] ?? m[2];
    const tableName = m[3];
    const rest = m[4];

    // Extract FOR <command>
    const forMatch = rest.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i);
    const command = forMatch ? forMatch[1].toUpperCase() : "ALL";

    // Extract TO <roles...>, stopping at USING/WITH CHECK/end
    const toMatch = rest.match(
      /\bTO\s+([\w",\s]+?)(?=\s+(?:USING|WITH\s+CHECK|AS\s+(?:PERMISSIVE|RESTRICTIVE))\b|$)/i,
    );
    const roles = toMatch
      ? toMatch[1]
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean)
      : [];

    const usingMatch = rest.match(/\bUSING\s*\(/i);
    let usingBody = "";
    if (usingMatch) {
      // Re-locate in original sql: simpler to paren-match from the match
      // within `rest` directly.
      const localOpen = usingMatch.index + usingMatch[0].length - 1;
      const localClose = findMatchingParen(rest, localOpen);
      if (localClose > localOpen)
        usingBody = rest.slice(localOpen + 1, localClose);
    }

    const checkMatch = rest.match(/\bWITH\s+CHECK\s*\(/i);
    let checkBody = "";
    if (checkMatch) {
      const localOpen = checkMatch.index + checkMatch[0].length - 1;
      const localClose = findMatchingParen(rest, localOpen);
      if (localClose > localOpen)
        checkBody = rest.slice(localOpen + 1, localClose);
    }

    policies.push({
      name: policyName,
      table: tableName,
      command,
      roles,
      using: usingBody.trim(),
      check: checkBody.trim(),
      sourceFile,
    });
  }
  return policies;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

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
  if (policy.command !== "SELECT" && policy.command !== "ALL") return false;
  const body = policy.using.trim().toLowerCase();
  return body === "true";
}

function classifyTable(policies) {
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
    authPolicies.every(
      (p) => p.command === "SELECT" || p.command === "ALL" || p.check === "",
    )
  ) {
    return "public_read";
  }

  if (authPolicies.length === 0) return "admin_only";

  return "unclassified";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function main() {
  const sources = readAllMigrations();
  const tablesByName = new Map();
  const policiesByTable = new Map();

  for (const { file, sql } of sources) {
    for (const t of extractTables(sql, file)) {
      const existing = tablesByName.get(t.name);
      if (existing) {
        // Merge columns from ALTER TABLE or re-declarations (future-proof).
        existing.columns = [...new Set([...existing.columns, ...t.columns])];
        if (!existing.files.includes(file)) existing.files.push(file);
      } else {
        tablesByName.set(t.name, {
          name: t.name,
          columns: t.columns,
          files: [file],
        });
      }
    }
    for (const p of parsePolicies(sql, file)) {
      if (!policiesByTable.has(p.table)) policiesByTable.set(p.table, []);
      policiesByTable.get(p.table).push(p);
    }
  }

  const tables = [];
  const unclassifiedTables = [];

  for (const [name, entry] of tablesByName) {
    const policies = policiesByTable.get(name) ?? [];
    const classification = classifyTable(policies);

    const normalized = {
      name,
      columns: [...entry.columns].sort(),
      rls_classification: classification,
      policies: policies
        .map((p) => ({
          name: p.name,
          command: p.command,
          roles: [...p.roles].sort(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      sourceFiles: [...entry.files]
        .map((f) => f.split(path.sep).join("/"))
        .sort(),
    };
    tables.push(normalized);
    if (classification === "unclassified") {
      unclassifiedTables.push({
        table: name,
        reason:
          "policies present but none match the workspace/user/service/public classification patterns",
      });
    }
  }

  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  unclassifiedTables.sort((a, b) =>
    a.table < b.table ? -1 : a.table > b.table ? 1 : 0,
  );

  const output = {
    schemaVersion: 1,
    tables,
    unclassified: unclassifiedTables,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(
    `[proof:parse] parsed ${sources.length} migration file(s); wrote ${tables.length} table(s), ${unclassifiedTables.length} unclassified to ${OUTPUT_PATH}`,
  );
  if (unclassifiedTables.length > 0) {
    console.log(`[proof:parse] unclassified tables:`);
    for (const u of unclassifiedTables)
      console.log(`  - ${u.table}: ${u.reason}`);
  }
}

// Only run the CLI when executed directly, so importing this module for
// `tableNamesIn` / `CREATE_TABLE_RE` has no side effects.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
