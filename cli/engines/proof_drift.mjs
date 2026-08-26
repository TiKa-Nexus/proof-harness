#!/usr/bin/env node
// ---------------------------------------------------------------------------
// proof_drift.mjs — PROOF-SURFACE drift.
//
// What else did this PR do — on the surfaces the proof system can see?
//
// Every other proof check grades presence: the mission says what must exist
// and hold, and the validator confirms it does. Nothing in that loop notices
// the change the mission never asked for — an extra action in an unrelated
// module, a table quietly reshaped, a new runtime dependency, an auth guard
// dropped from an existing action. This script closes that gap by diffing the
// DERIVED artifacts, not the source:
//
//   .proof/capabilities.json   every action + its scanner-derived facts
//   .proof/schema.json         every table: columns, RLS class, policies
//                              (name, command, roles)
//   package.json               root dependency surface
//   pnpm-lock.yaml             changed-or-not (resolution drift signal)
//
// against the same artifacts regenerated from the PR's merge base. The
// artifact generators are pure filesystem scripts, so the base side is rebuilt
// by extracting the base tree (`git archive`) and running THAT checkout's own
// generators — no database, no install, a few seconds.
//
// WHAT THIS IS NOT. Drift sees exactly what the scanners see, and no more. It
// does NOT see: RLS policy predicates (USING / WITH CHECK bodies), column
// types, constraints, or defaults; SQL grants, triggers, or function bodies;
// transitive dependency contents; or ordinary product behavior. "No drift"
// means "no change on the proof-relevant derived surfaces", never "nothing
// else changed" — behavior inside declared scope still merits review or a
// trace requirement.
//
// Enforcement is opt-in and planner-owned. When `.proof/current-mission.json`
// declares an `expectedChanges` budget, every HIGH-severity delta outside it
// fails as:
//
//   [PROOF_FAIL] drift_undeclared: <what changed and why it matters>
//
// and a declared budget that cannot be assessed (base unavailable, base
// artifacts unbuildable) FAILS CLOSED as `drift_unassessed` instead of
// exiting 0. Without the budget (or without a mission), the report is
// informational: the full delta is printed and written to `.proof/drift.json`
// (gitignored) so a consumer can read one small artifact instead of the diff.
//
// The budget is narrow by default (see evaluateDrift): `modules` covers only
// ADDED actions; existing-action changes need exact refs in `actions`; table
// declarations may be narrowed to change facets; every runtime dependency
// delta (add, remove, version change) is high-severity; lockfile-only
// resolution changes need an explicit `lockfile: true`.
//
// Severity:
//   high — action added/removed/changed; table added/removed/reshaped
//          (columns, RLS classification, policies incl. role lists); any
//          runtime dependency delta; lockfile-only resolution change.
//   info — action file moved; devDependency added; lockfile change that
//          accompanies package.json dependency changes.
//
// Usage:
//   node scripts/proof_drift.mjs                 # base = merge-base with main
//   node scripts/proof_drift.mjs --base <ref>    # explicit base (CI passes
//                                                #   the PR base sha)
//   node scripts/proof_drift.mjs --json          # machine-readable report
//
// The base may also be supplied via PROOF_DRIFT_BASE. An explicitly supplied
// base that does not resolve is an error (a misconfigured gate must be loud).
// An undetectable base (no main ref, shallow history) downgrades to "not
// assessed" with exit 0 ONLY in report-only mode; with a declared budget it
// fails closed as drift_unassessed.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Single source of truth for the facet vocabularies, shared with both mission
// validators (which reject exactly what the standalone budget check below
// rejects) and with the TS types derived from the same file.
import {
  ACTION_CHANGE_KINDS,
  TABLE_CHANGE_KINDS,
} from "../../dist/portable-vocabulary.js";
import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const CAPABILITIES_PATH = CONFIG.artifacts.capabilities;
const SCHEMA_PATH = CONFIG.artifacts.schema;
const MISSION_PATH = CONFIG.mission.current;
const OUTPUT_PATH = CONFIG.artifacts.drift;

// Paths whose contents feed the derived artifacts. If none of them differ from
// the base, there is nothing to regenerate or diff.
const SOURCE_PATHS = CONFIG.driftSources;

// ---------------------------------------------------------------------------
// Diffing (pure — unit-tested directly)
// ---------------------------------------------------------------------------

function byKey(list, keyOf) {
  const map = new Map();
  for (const item of list ?? []) map.set(keyOf(item), item);
  return map;
}

function setDiff(baseList, headList) {
  const base = new Set(baseList ?? []);
  const head = new Set(headList ?? []);
  return {
    added: [...head].filter((v) => !base.has(v)).sort(),
    removed: [...base].filter((v) => !head.has(v)).sort(),
  };
}

/**
 * Field-level comparison of one action's security-relevant facts. Returns
 * human-readable notes; empty means "same action" (a moved file is reported
 * separately as info).
 */
function actionChanges(base, head) {
  const notes = [];
  // Facets mirror the table decomposition: enforcement covers a modified
  // action only when EVERY facet is declared, so a mission expecting an
  // invariant declaration to change never quietly authorizes an RBAC/auth
  // middleware change on the same action.
  const facets = [];

  const metadataNotes = [];
  for (const field of [
    "verb",
    "object",
    "acceptsWorkspaceId",
    "internalOnly",
    "usesDirectUpdateTag",
  ]) {
    const before = base[field] ?? null;
    const after = head[field] ?? null;
    if (before !== after) metadataNotes.push(`${field}: ${before} -> ${after}`);
  }
  if (metadataNotes.length > 0) {
    facets.push("metadata_changed");
    notes.push(...metadataNotes);
  }

  const invariants = setDiff(base.invariants, head.invariants);
  if (invariants.added.length > 0 || invariants.removed.length > 0) {
    facets.push("invariants_changed");
    if (invariants.added.length > 0)
      notes.push(`invariants added: ${invariants.added.join(", ")}`);
    if (invariants.removed.length > 0)
      notes.push(`invariants removed: ${invariants.removed.join(", ")}`);
  }

  const middlewareNotes = [];
  for (const guard of ["auth", "tenantIsolation", "rbac"]) {
    const before = base.middleware?.[guard] ?? null;
    const after = head.middleware?.[guard] ?? null;
    if (before !== after)
      middlewareNotes.push(`middleware.${guard}: ${before} -> ${after}`);
  }
  if (middlewareNotes.length > 0) {
    facets.push("middleware_changed");
    notes.push(...middlewareNotes);
  }

  const mutationKey = (m) => `${m.table}:${m.operation}`;
  const mutations = setDiff(
    (base.serviceRoleMutations ?? []).map(mutationKey),
    (head.serviceRoleMutations ?? []).map(mutationKey),
  );
  if (mutations.added.length > 0 || mutations.removed.length > 0) {
    facets.push("service_role_mutations_changed");
    if (mutations.added.length > 0)
      notes.push(`serviceRoleMutations added: ${mutations.added.join(", ")}`);
    if (mutations.removed.length > 0)
      notes.push(
        `serviceRoleMutations removed: ${mutations.removed.join(", ")}`,
      );
  }

  return { facets, notes };
}

/** Diff two capabilities.json artifacts into drift entries. */
export function diffCapabilities(baseArtifact, headArtifact) {
  const keyOf = (c) => `${c.module}:${c.name}`;
  const base = byKey(baseArtifact?.capabilities, keyOf);
  const head = byKey(headArtifact?.capabilities, keyOf);
  const entries = [];

  for (const [key, capability] of head) {
    if (!base.has(key)) {
      entries.push({
        area: "action",
        key,
        module: capability.module,
        change: "added",
        facets: ["added"],
        severity: "high",
        detail: `new action in ${capability.file ?? "unknown file"}`,
      });
    }
  }
  for (const [key, capability] of base) {
    if (!head.has(key)) {
      entries.push({
        area: "action",
        key,
        module: capability.module,
        change: "removed",
        facets: ["removed"],
        severity: "high",
        detail: `action no longer found (was ${capability.file ?? "unknown file"})`,
      });
    }
  }
  for (const [key, headCapability] of head) {
    const baseCapability = base.get(key);
    if (!baseCapability) continue;
    const { facets, notes } = actionChanges(baseCapability, headCapability);
    if (facets.length > 0) {
      entries.push({
        area: "action",
        key,
        module: headCapability.module,
        change: "modified",
        facets,
        severity: "high",
        detail: notes.join("; "),
      });
    } else if (baseCapability.file !== headCapability.file) {
      entries.push({
        area: "action",
        key,
        module: headCapability.module,
        change: "moved",
        severity: "info",
        detail: `${baseCapability.file} -> ${headCapability.file}`,
      });
    }
  }
  return entries;
}

/** Diff two schema.json artifacts into drift entries. */
export function diffSchema(baseArtifact, headArtifact) {
  const base = byKey(baseArtifact?.tables, (t) => t.name);
  const head = byKey(headArtifact?.tables, (t) => t.name);
  const entries = [];

  for (const [name, table] of head) {
    if (!base.has(name)) {
      entries.push({
        area: "table",
        key: name,
        change: "added",
        facets: ["added"],
        severity: "high",
        detail: `new table (${table.rls_classification}, ${table.columns?.length ?? 0} column(s))`,
      });
    }
  }
  for (const [name] of base) {
    if (!head.has(name)) {
      entries.push({
        area: "table",
        key: name,
        change: "removed",
        facets: ["removed"],
        severity: "high",
        detail: "table no longer present in migrations",
      });
    }
  }
  for (const [name, headTable] of head) {
    const baseTable = base.get(name);
    if (!baseTable) continue;
    const notes = [];
    // Facets are the machine-readable decomposition of a "modified" entry.
    // Enforcement covers a table change only when EVERY facet is declared,
    // so `columns_added` on a declared table never authorizes a policy edit.
    const facets = [];
    if (baseTable.rls_classification !== headTable.rls_classification) {
      facets.push("rls_classification_changed");
      notes.push(
        `rls_classification: ${baseTable.rls_classification} -> ${headTable.rls_classification}`,
      );
    }
    const columns = setDiff(baseTable.columns, headTable.columns);
    if (columns.added.length > 0) {
      facets.push("columns_added");
      notes.push(`columns added: ${columns.added.join(", ")}`);
    }
    if (columns.removed.length > 0) {
      facets.push("columns_removed");
      notes.push(`columns removed: ${columns.removed.join(", ")}`);
    }
    // Roles are part of the identity: rewriting `TO service_role` as
    // `TO authenticated` widens who a policy reaches without renaming it, and
    // may leave the coarse rls_classification untouched.
    const policyKey = (p) =>
      `${p.name} FOR ${p.command} TO ${[...(p.roles ?? [])].sort().join(",") || "PUBLIC"}`;
    const policies = setDiff(
      (baseTable.policies ?? []).map(policyKey),
      (headTable.policies ?? []).map(policyKey),
    );
    if (policies.added.length > 0 || policies.removed.length > 0) {
      facets.push("policies_changed");
      if (policies.added.length > 0)
        notes.push(`policies added: ${policies.added.join("; ")}`);
      if (policies.removed.length > 0)
        notes.push(`policies removed: ${policies.removed.join("; ")}`);
    }
    if (facets.length > 0) {
      entries.push({
        area: "table",
        key: name,
        change: "modified",
        facets,
        severity: "high",
        detail: notes.join("; "),
      });
    }
  }
  return entries;
}

/** Diff two package.json files into drift entries. */
export function diffDependencies(basePkg, headPkg) {
  const entries = [];
  const runtime = {
    base: basePkg?.dependencies ?? {},
    head: headPkg?.dependencies ?? {},
  };
  for (const name of Object.keys(runtime.head).sort()) {
    if (!(name in runtime.base)) {
      entries.push({
        area: "dependency",
        key: name,
        change: "added",
        severity: "high",
        detail: `new runtime dependency ${name}@${runtime.head[name]}`,
      });
    } else if (runtime.base[name] !== runtime.head[name]) {
      // High, like additions: a swap or downgrade changes what ships as
      // surely as a new package does.
      entries.push({
        area: "dependency",
        key: name,
        change: "version_changed",
        severity: "high",
        detail: `${runtime.base[name]} -> ${runtime.head[name]}`,
      });
    }
  }
  for (const name of Object.keys(runtime.base).sort()) {
    if (!(name in runtime.head)) {
      entries.push({
        area: "dependency",
        key: name,
        change: "removed",
        severity: "high",
        detail: `runtime dependency removed (was ${runtime.base[name]})`,
      });
    }
  }
  const dev = {
    base: basePkg?.devDependencies ?? {},
    head: headPkg?.devDependencies ?? {},
  };
  for (const name of Object.keys(dev.head).sort()) {
    if (!(name in dev.base)) {
      entries.push({
        area: "dev-dependency",
        key: name,
        change: "added",
        severity: "info",
        detail: `new devDependency ${name}@${dev.head[name]}`,
      });
    }
  }
  return entries;
}

/** Full drift between base and head artifact sets, deterministically ordered. */
export function buildDrift({
  baseCapabilities,
  headCapabilities,
  baseSchema,
  headSchema,
  basePkg,
  headPkg,
}) {
  const entries = [
    ...diffCapabilities(baseCapabilities, headCapabilities),
    ...diffSchema(baseSchema, headSchema),
    ...diffDependencies(basePkg, headPkg),
  ];
  entries.sort(
    (a, b) => a.area.localeCompare(b.area) || a.key.localeCompare(b.key),
  );
  return entries;
}

/**
 * Grade the drift against a mission's `expectedChanges` budget.
 *
 * `expectedChanges` absent (or no mission at all) means report-only: nothing
 * is undeclared because nothing was bounded. When present, every
 * high-severity entry must fall inside the declared budget, and the budget is
 * deliberately narrow:
 *
 *   action entries      -> `actions` names the exact `module:name` ref
 *                          (string = any change; { ref, changes } narrows to
 *                          facets: added, removed, middleware_changed,
 *                          invariants_changed, service_role_mutations_changed,
 *                          metadata_changed — a modified action is covered
 *                          only when EVERY facet is declared).
 *                          `modules` covers ONLY "added" — a module
 *                          declaration never authorizes modifying or removing
 *                          an existing action.
 *   table entries       -> `tables` names the table (string = any change;
 *                          { name, changes } narrows). A "modified" entry is
 *                          covered only when EVERY facet is declared.
 *   dependency entries  -> `dependencies` names the package; covers added,
 *                          removed, and version_changed alike.
 *   lockfile entry      -> `lockfile: true` (only a lockfile-only resolution
 *                          change is high-severity; one accompanying declared
 *                          package.json changes is informational).
 *
 * Declared budget that saw no change is reported (not failed): a planner may
 * budget for work the executor solved differently, and the mission's positive
 * requirements already fail if a required thing is missing.
 */
export function evaluateDrift(entries, expectedChanges) {
  if (!expectedChanges || typeof expectedChanges !== "object") {
    return { enforced: false, undeclared: [], unusedDeclarations: [] };
  }
  const modules = new Set(expectedChanges.modules ?? []);
  const dependencies = new Set(expectedChanges.dependencies ?? []);
  // string shorthand -> null (any change); object -> Set of allowed kinds.
  const normalize = (list, nameField) =>
    new Map(
      (list ?? []).map((entry) =>
        typeof entry === "string"
          ? [entry, null]
          : [entry[nameField], entry.changes ? new Set(entry.changes) : null],
      ),
    );
  const actions = normalize(expectedChanges.actions, "ref");
  const tables = normalize(expectedChanges.tables, "name");

  const declared = (entry) => {
    if (entry.area === "action") {
      if (actions.has(entry.key)) {
        const allowed = actions.get(entry.key);
        if (allowed === null) return true;
        return (entry.facets ?? [entry.change]).every((facet) =>
          allowed.has(facet),
        );
      }
      return entry.change === "added" && modules.has(entry.module);
    }
    if (entry.area === "table") {
      if (!tables.has(entry.key)) return false;
      const allowed = tables.get(entry.key);
      if (allowed === null) return true;
      return (entry.facets ?? [entry.change]).every((facet) =>
        allowed.has(facet),
      );
    }
    if (entry.area === "dependency") return dependencies.has(entry.key);
    if (entry.area === "lockfile") return expectedChanges.lockfile === true;
    return true;
  };

  const undeclared = entries.filter(
    (entry) => entry.severity === "high" && !declared(entry),
  );

  const touchedModules = new Set(
    entries
      .filter((e) => e.area === "action" && e.change === "added")
      .map((e) => e.module),
  );
  const touchedActions = new Set(
    entries.filter((e) => e.area === "action").map((e) => e.key),
  );
  const touchedTables = new Set(
    entries.filter((e) => e.area === "table").map((e) => e.key),
  );
  const touchedDependencies = new Set(
    entries.filter((e) => e.area === "dependency").map((e) => e.key),
  );
  const unusedDeclarations = [
    ...[...modules]
      .filter((m) => !touchedModules.has(m))
      .map((m) => ({ scope: "modules", name: m })),
    ...[...actions.keys()]
      .filter((ref) => !touchedActions.has(ref))
      .map((ref) => ({ scope: "actions", name: ref })),
    ...[...tables.keys()]
      .filter((t) => !touchedTables.has(t))
      .map((t) => ({ scope: "tables", name: t })),
    ...[...dependencies]
      .filter((d) => !touchedDependencies.has(d))
      .map((d) => ({ scope: "dependencies", name: d })),
    ...(expectedChanges.lockfile === true &&
    !entries.some((e) => e.area === "lockfile")
      ? [{ scope: "lockfile", name: CONFIG.repository.lockfile }]
      : []),
  ];

  return { enforced: true, undeclared, unusedDeclarations };
}

// ---------------------------------------------------------------------------
// Base resolution + artifact regeneration
// ---------------------------------------------------------------------------

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/**
 * Resolve the base commit to diff against.
 *
 * Explicit (`--base` / PROOF_DRIFT_BASE) must resolve or the whole run fails:
 * CI passing a sha that is not fetched is a configuration bug, and a gate that
 * silently skips on misconfiguration is not a gate. Auto-detection falls back
 * through origin/main and main to a merge-base, and reports `null` (drift not
 * assessed) when the repo has no usable base.
 */
export function resolveBase(explicit) {
  if (explicit) {
    const sha = tryGit(["rev-parse", "--verify", `${explicit}^{commit}`]);
    if (!sha) {
      throw new Error(
        `base "${explicit}" does not resolve to a commit — fetch it (e.g. \`git fetch origin <sha>\`) or fix the --base/PROOF_DRIFT_BASE value`,
      );
    }
    const mergeBase = tryGit(["merge-base", sha, "HEAD"]);
    return { sha: mergeBase ?? sha, ref: explicit };
  }
  for (const ref of ["origin/main", "main"]) {
    if (tryGit(["rev-parse", "--verify", `${ref}^{commit}`]) === null) continue;
    const mergeBase = tryGit(["merge-base", ref, "HEAD"]);
    if (mergeBase) return { sha: mergeBase, ref };
  }
  return null;
}

/**
 * Materialize the base tree and regenerate its proof artifacts using the base
 * checkout's OWN generator scripts (they are pure filesystem scripts with no
 * node_modules imports, so no install is needed). Returns the artifact set or
 * throws with a reason.
 */
function generateBaseArtifacts(baseSha, tmpDir) {
  const tarPath = path.join(tmpDir, "base.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tarPath, baseSha], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const treeDir = path.join(tmpDir, "tree");
  fs.mkdirSync(treeDir, { recursive: true });
  execFileSync("tar", ["-xf", tarPath, "-C", treeDir], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const generators = [
    ["scripts/scan_proof_capabilities.mjs"],
    ["scripts/aggregate_migrations.mjs", "--fresh"],
    ["scripts/parse_proof_schema.mjs"],
  ];
  for (const [script, ...args] of generators) {
    if (!fs.existsSync(path.join(treeDir, script))) {
      throw new Error(`base commit has no ${script} — too old to diff against`);
    }
    execFileSync("node", [script, ...args], {
      cwd: treeDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  return {
    capabilities: JSON.parse(
      fs.readFileSync(path.join(treeDir, CAPABILITIES_PATH), "utf8"),
    ),
    schema: JSON.parse(
      fs.readFileSync(path.join(treeDir, SCHEMA_PATH), "utf8"),
    ),
    pkg: JSON.parse(
      fs.readFileSync(
        path.join(treeDir, CONFIG.repository.packageJson),
        "utf8",
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson(file, { hint } = {}) {
  if (!fs.existsSync(file)) {
    console.error(
      `[proof:drift] ${file} not found.${hint ? `\n  suggestion: ${hint}` : ""}`,
    );
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[proof:drift] ${file} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}

function loadExpectedChanges() {
  if (!fs.existsSync(MISSION_PATH)) return { mission: null, expected: null };
  let mission;
  try {
    mission = JSON.parse(fs.readFileSync(MISSION_PATH, "utf8"));
  } catch (err) {
    // An unparseable mission might contain a budget this run cannot see.
    // Downgrading to report-only would fail open on exactly the standalone
    // invocation that skipped proof:verify, so drift fails it itself.
    console.error(
      `[PROOF_FAIL] manifest_shape: ${MISSION_PATH} is not valid JSON (${err.message}); drift cannot tell whether it declares an expectedChanges budget`,
    );
    console.error(
      `  suggestion: fix the manifest — proof:verify reports the same error as manifest_shape`,
    );
    process.exit(1);
  }
  const expected = mission?.expectedChanges;
  if (expected === undefined) return { mission, expected: null };
  // Shape errors are proof:verify's to fail; here a malformed block must not
  // half-enforce, so it is ignored with a warning. The checks mirror
  // expectedChangesShapeIssues in validate-mission.ts, loosely: string lists
  // for modules/dependencies, string-or-object entries for actions/tables,
  // boolean lockfile.
  const stringList = (list) =>
    list === undefined ||
    (Array.isArray(list) &&
      list.every((v) => typeof v === "string" && v.length > 0));
  const entryList = (list, nameField, kinds) =>
    list === undefined ||
    (Array.isArray(list) &&
      list.every(
        (entry) =>
          (typeof entry === "string" && entry.length > 0) ||
          (entry &&
            typeof entry === "object" &&
            typeof entry[nameField] === "string" &&
            entry[nameField].length > 0 &&
            (entry.changes === undefined ||
              (Array.isArray(entry.changes) &&
                entry.changes.length > 0 &&
                entry.changes.every((c) => kinds.includes(c))))),
      ));
  const valid =
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    stringList(expected.modules) &&
    stringList(expected.dependencies) &&
    entryList(expected.actions, "ref", ACTION_CHANGE_KINDS) &&
    entryList(expected.tables, "name", TABLE_CHANGE_KINDS) &&
    (expected.lockfile === undefined || typeof expected.lockfile === "boolean");
  if (!valid) {
    // A planner declared a budget; a malformed one must never silently
    // disable the enforcement it names — not even when proof:drift is run
    // standalone, outside the proof:check chain where proof:verify would
    // have failed it first.
    console.error(
      `[PROOF_FAIL] manifest_shape: ${MISSION_PATH} expectedChanges is malformed; drift will not run report-only with a broken budget`,
    );
    console.error(
      `  suggestion: fix the block — proof:verify names the exact field errors as manifest_shape`,
    );
    process.exit(1);
  }
  return { mission, expected };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function printEntries(entries) {
  const width = (get) =>
    Math.max(...entries.map((e) => String(get(e)).length), 1);
  const areaW = Math.max(
    width((e) => e.area),
    "area".length,
  );
  const keyW = Math.max(
    width((e) => e.key),
    "key".length,
  );
  const changeW = Math.max(
    width((e) => e.change),
    "change".length,
  );
  const sevW = Math.max(
    width((e) => e.severity),
    "severity".length,
  );
  const row = (a, k, c, s, d) =>
    console.log(
      `  ${String(a).padEnd(areaW)}  ${String(k).padEnd(keyW)}  ${String(c).padEnd(changeW)}  ${String(s).padEnd(sevW)}  ${d}`,
    );
  row("area", "key", "change", "severity", "detail");
  row(
    "-".repeat(areaW),
    "-".repeat(keyW),
    "-".repeat(changeW),
    "-".repeat(sevW),
    "------",
  );
  for (const e of entries) row(e.area, e.key, e.change, e.severity, e.detail);
}

export function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const baseFlagIndex = args.indexOf("--base");
  const explicitBase =
    (baseFlagIndex !== -1 ? args[baseFlagIndex + 1] : undefined) ??
    (process.env.PROOF_DRIFT_BASE?.trim() || undefined);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node scripts/proof_drift.mjs [--base <ref>] [--json]

Diffs the derived proof artifacts (capabilities.json, schema.json) and
package.json against the PR's merge base and reports every action, table, and
dependency delta. When .proof/current-mission.json declares expectedChanges,
high-severity deltas outside that scope fail as [PROOF_FAIL] drift_undeclared.
Without it, the report is informational. Writes ${OUTPUT_PATH}.`);
    return;
  }
  const known = new Set(["--json", "--base"]);
  const unknown = args.filter(
    (a, i) =>
      !known.has(a) && !(i === baseFlagIndex + 1 && baseFlagIndex !== -1),
  );
  if (unknown.length > 0) {
    console.error(`[proof:drift] unknown flag: ${unknown.join(", ")}`);
    process.exit(2);
  }

  const headCapabilities = readJson(CAPABILITIES_PATH, {
    hint: "run `pnpm proof:build` first — drift diffs the regenerated artifacts",
  });
  const headSchema = readJson(SCHEMA_PATH, {
    hint: "run `pnpm proof:build` first — drift diffs the regenerated artifacts",
  });
  const headPkg = readJson(CONFIG.repository.packageJson, {});

  let base;
  try {
    base = resolveBase(explicitBase);
  } catch (err) {
    console.error(`[proof:drift] ${err.message}`);
    process.exit(2);
  }

  // The budget is loaded before any base work: whether drift may silently
  // downgrade to "not assessed" depends on whether a planner bounded this PR.
  const { expected } = loadExpectedChanges();

  // Fail closed when a planner declared a budget: an unassessable drift check
  // that exits 0 would let exactly the change the budget forbids through.
  // Without a budget the check is informational and stays permissive.
  const notAssessed = (reason) => {
    writeReport({
      schemaVersion: 1,
      assessed: false,
      reason,
      generatedAt: new Date().toISOString(),
    });
    if (expected) {
      console.error(
        `[PROOF_FAIL] drift_unassessed: the mission declares expectedChanges but drift could not be assessed: ${reason}`,
      );
      console.error(
        `  suggestion: fix the base resolution (fetch history, set PROOF_DRIFT_BASE) — enforced drift never passes unassessed`,
      );
      process.exit(1);
    }
    console.error(`[proof:drift] drift not assessed: ${reason}`);
  };

  if (!base) {
    notAssessed(
      "no base ref found (origin/main or main) — pass --base or set PROOF_DRIFT_BASE",
    );
    return;
  }

  const headSha = tryGit(["rev-parse", "HEAD"]);

  // Lockfile drift is tracked separately from the package.json surface: a
  // lockfile that changes while the dependency surface does not means the
  // RESOLUTION changed (a swapped tarball, a widened range realized), which
  // no package.json diff can see.
  let lockfileChanged = false;
  if (
    fs.existsSync(CONFIG.repository.lockfile) ||
    tryGit(["cat-file", "-e", `${base.sha}:${CONFIG.repository.lockfile}`]) !==
      null
  ) {
    try {
      execFileSync(
        "git",
        ["diff", "--quiet", base.sha, "--", CONFIG.repository.lockfile],
        { stdio: "ignore" },
      );
    } catch {
      lockfileChanged = true;
    }
  }

  // Fast path: when nothing feeding the artifacts differs from the base
  // (committed or not), there is no drift and no need to rebuild anything.
  let sourceUnchanged = false;
  try {
    execFileSync("git", ["diff", "--quiet", base.sha, "--", ...SOURCE_PATHS], {
      stdio: "ignore",
    });
    sourceUnchanged = true;
  } catch {
    sourceUnchanged = false;
  }

  let entries = [];
  if (!sourceUnchanged) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-drift-"));
    let baseArtifacts;
    try {
      baseArtifacts = generateBaseArtifacts(base.sha, tmpDir);
    } catch (err) {
      notAssessed(
        `could not rebuild base artifacts at ${base.sha.slice(0, 12)}: ${err.message}`,
      );
      return;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    entries = buildDrift({
      baseCapabilities: baseArtifacts.capabilities,
      headCapabilities,
      baseSchema: baseArtifacts.schema,
      headSchema,
      basePkg: baseArtifacts.pkg,
      headPkg,
    });
  }

  if (lockfileChanged) {
    const dependenciesAlsoChanged = entries.some(
      (e) => e.area === "dependency" || e.area === "dev-dependency",
    );
    entries.push({
      area: "lockfile",
      key: CONFIG.repository.lockfile,
      change: "modified",
      // Alongside package.json dependency changes a lockfile update is the
      // expected companion; alone, it is a resolution change nobody declared.
      severity: dependenciesAlsoChanged ? "info" : "high",
      detail: dependenciesAlsoChanged
        ? "lockfile updated alongside package.json dependency changes"
        : "lockfile changed while the package.json dependency surface did not — dependency RESOLUTION changed",
    });
  }

  const evaluation = evaluateDrift(entries, expected);

  const report = {
    schemaVersion: 1,
    assessed: true,
    base: { sha: base.sha, ref: base.ref ?? null },
    head: { sha: headSha },
    generatedAt: new Date().toISOString(),
    entries,
    enforcement: evaluation,
  };
  writeReport(report);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    if (evaluation.undeclared.length > 0) process.exit(1);
    return;
  }

  const baseLabel = `${base.sha.slice(0, 12)}${base.ref ? ` (${base.ref})` : ""}`;
  if (entries.length === 0) {
    console.log(
      `[proof:drift] PASS · no action/table/dependency drift vs ${baseLabel}`,
    );
    return;
  }

  console.log(`\nDRIFT vs ${baseLabel}`);
  console.log("─".repeat(76));
  console.log("");
  printEntries(entries);
  const high = entries.filter((e) => e.severity === "high");
  console.log(`\n  ${entries.length} change(s) · ${high.length} high-severity`);

  if (!evaluation.enforced) {
    console.log(
      `\n[proof:drift] report-only: no expectedChanges budget in ${MISSION_PATH} — ` +
        `declare { modules, actions, tables, dependencies, lockfile } there to fail on undeclared high-severity drift`,
    );
    return;
  }

  if (evaluation.unusedDeclarations.length > 0) {
    console.log(
      `\n  declared but unchanged: ` +
        evaluation.unusedDeclarations
          .map((u) => `${u.scope}:${u.name}`)
          .join(", "),
    );
  }

  if (evaluation.undeclared.length === 0) {
    console.log(
      `\n[proof:drift] PASS · every high-severity change is inside the mission's declared scope`,
    );
    return;
  }

  console.error("");
  for (const entry of evaluation.undeclared) {
    const scope =
      entry.area === "action"
        ? entry.change === "added"
          ? `neither expectedChanges.actions ("${entry.key}") nor expectedChanges.modules ("${entry.module}") covers it`
          : `expectedChanges.actions does not cover "${entry.key}" for: ${(entry.facets ?? [entry.change]).join(", ")} — a module declaration only covers ADDED actions`
        : entry.area === "table"
          ? `expectedChanges.tables does not cover "${entry.key}" for: ${(entry.facets ?? [entry.change]).join(", ")}`
          : entry.area === "lockfile"
            ? `a lockfile-only resolution change requires expectedChanges.lockfile: true`
            : `dependency "${entry.key}" is not in expectedChanges.dependencies`;
    console.error(
      `[PROOF_FAIL] drift_undeclared: ${entry.area} ${entry.key} ${entry.change} (${entry.detail}) — ${scope}`,
    );
    console.error(
      `  suggestion: revert the change if it was unplanned, or have the mission owner widen expectedChanges in ${MISSION_PATH}`,
    );
  }
  process.exit(1);
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  main();
}
