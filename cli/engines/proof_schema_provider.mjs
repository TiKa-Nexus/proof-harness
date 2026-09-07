import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  withLocalPostgres,
  readPostgresCatalog,
  sourceHash,
} from "../../dist/node.js";
import { evidenceExclusions } from "../config.mjs";
import { classifyTable } from "./proof_schema_classification.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const text = (value) => typeof value === "string" && value.length > 0;
const names = (value) =>
  Array.isArray(value) &&
  value.every(text) &&
  new Set(value).size === value.length;
function validateTables(tables) {
  if (!Array.isArray(tables))
    throw new Error("provider tables must be an array");
  const seen = new Set();
  for (const table of tables) {
    if (
      !table ||
      !text(table.name) ||
      !text(table.schema) ||
      !names(table.columns) ||
      typeof table.rls_enabled !== "boolean" ||
      typeof table.rls_forced !== "boolean" ||
      !Array.isArray(table.policies)
    )
      throw new Error("provider returned malformed table facts");
    const key = `${table.schema}.${table.name}`;
    if (seen.has(key)) throw new Error(`duplicate catalog table ${key}`);
    seen.add(key);
    const policies = new Set();
    for (const policy of table.policies) {
      if (
        !policy ||
        !text(policy.name) ||
        !["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"].includes(
          policy.command,
        ) ||
        !names(policy.roles) ||
        !policy.roles.length ||
        !["PERMISSIVE", "RESTRICTIVE"].includes(policy.mode) ||
        typeof policy.using !== "string" ||
        typeof policy.check !== "string"
      )
        throw new Error(`malformed policy on ${key}`);
      if (policies.has(policy.name))
        throw new Error(`duplicate policy on ${key}`);
      policies.add(policy.name);
    }
  }
}
function inside(root, relative) {
  if (!text(relative) || path.isAbsolute(relative))
    throw new Error("schemaProvider must name a repository-relative module");
  const target = fs.realpathSync(path.resolve(root, relative));
  const rel = path.relative(fs.realpathSync(root), target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("schema provider escapes its source tree");
  return target;
}

/** Consumer providers return facts; the harness owns validation and classification. */
export async function assessWithProvider(config) {
  let output;
  try {
    const providerPath = inside(config.rootDir, config.schemaProvider);
    const providerHash = hash(fs.readFileSync(providerPath));
    const directory = path.resolve(config.rootDir, config.roots.migrations);
    const migrations = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const file = path.join(directory, e.name);
        const sql = fs.readFileSync(file, "utf8");
        return {
          path: path.relative(config.rootDir, file).split(path.sep).join("/"),
          sql,
          sha256: hash(sql),
        };
      });
    const inputHash = hash(
      JSON.stringify(migrations.map(({ path, sha256 }) => ({ path, sha256 }))),
    );
    const provider = (await import(pathToFileURL(providerPath).href)).default;
    if (typeof provider !== "function")
      throw new Error(
        "schema provider must export a default assessment function",
      );
    const result = await provider({
      protocolVersion: 1,
      rootDir: config.rootDir,
      migrations,
      inputHash,
      withLocalPostgres,
      readPostgresCatalog,
    });
    if (
      !result ||
      result.protocolVersion !== 1 ||
      typeof result.assessed !== "boolean" ||
      !Array.isArray(result.issues) ||
      !result.issues.every(text)
    )
      throw new Error("invalid schema provider assessment envelope");
    if (!result.assessed || result.issues.length)
      throw new Error(
        result.issues.join("; ") ||
          "schema provider did not complete assessment",
      );
    validateTables(result.tables);
    const tables = result.tables
      .map((table) => ({
        ...table,
        name:
          table.schema === "public"
            ? table.name
            : `${table.schema}.${table.name}`,
        columns: [...table.columns].sort(),
        policies: table.policies
          .map((p) => ({ ...p, roles: [...p.roles].sort() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        rls_classification: table.rls_enabled
          ? classifyTable(table.policies)
          : "unclassified",
        sourceFiles: migrations.map((m) => m.path),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A provider must not rewrite its inputs while constructing the catalog.
    const afterNames = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();
    if (
      JSON.stringify(afterNames) !==
        JSON.stringify(migrations.map((m) => path.basename(m.path)).sort()) ||
      providerHash !== hash(fs.readFileSync(providerPath))
    )
      throw new Error("provider or migration inputs changed during assessment");
    for (const migration of migrations)
      if (
        hash(fs.readFileSync(path.resolve(config.rootDir, migration.path))) !==
        migration.sha256
      )
        throw new Error("migration inputs changed during assessment");
    output = {
      schemaVersion: 1,
      assessed: true,
      issues: [],
      tables,
      unclassified: tables
        .filter((t) => t.rls_classification === "unclassified")
        .map((t) => ({
          table: t.name,
          reason: "catalog policies or RLS state need explicit review",
        })),
      assessment: {
        protocolVersion: 1,
        provider: config.schemaProvider,
        providerHash,
        inputHash,
        inputs: migrations.map(({ path, sha256 }) => ({ path, sha256 })),
        sourceHash: sourceHash(config.rootDir, evidenceExclusions(config)),
      },
    };
  } catch (error) {
    output = {
      schemaVersion: 1,
      assessed: false,
      issues: [{ reason: error.message }],
      tables: [],
      unclassified: [],
    };
  }
  const target = path.resolve(config.rootDir, config.artifacts.schema);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
  if (!output.assessed)
    throw new Error(
      `[PROOF_FAIL] schema_unassessed: ${output.issues.map((i) => i.reason).join("; ")}`,
    );
  console.log(
    `[proof:parse] catalog provider assessed ${output.tables.length} tables → ${config.artifacts.schema}`,
  );
}
