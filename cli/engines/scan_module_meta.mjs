#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scan_module_meta.mjs
//
// v1 module descriptor scanner.
//
// Merges what each module DECLARES about itself (`module.meta.ts`) with what
// its source SAYS, and writes `.proof/modules.json` — the file a planner reads
// instead of the codebase.
//
// Reads:
//   - app/__core/<module>/module.meta.ts
//   - app/__extensions/<module>/module.meta.ts
//   - app/__business-logic/<module>/module.meta.ts
//   - that module's src/db/migrations/*.sql   (which tables it owns)
//   - that module's src/**/*.ts{,x}           (which modules it imports)
//   - .proof/capabilities.json                (what it can be asked to do)
//
// Writes `.proof/modules.json`.
//
// The declared/derived split is the whole design. Purpose, decisions, inputs
// and defaults are declared, because no compiler knows them. Tables,
// dependencies, actions and file locations are derived, because a written copy
// of a derivable fact is a fact that will be wrong later and say nothing about
// it. The downstream prototype this replaces declared its dependencies and got
// three of five wrong on the first draft; every one of them read as obviously
// true.
//
// Descriptors are read with a plain `await import()`. Node 24 strips types
// natively, and because a descriptor imports its types with `import type` the
// alias import is erased before resolution — so this needs no TypeScript
// loader, no `npx`, and no network. Keeping it dependency-free is deliberate:
// a project planner has to be able to run `pnpm proof:modules` and get an
// answer in about a second, without Docker, a database, or a migration
// aggregate.
//
// Deliberately does no verification. `proof_module_check.mjs` checks the
// declared half against the code, and keeping the two apart means a broken
// claim fails the check rather than silently producing a smaller artifact.
//
// Output is deterministic (sorted, no timestamps) so two runs on one tree are
// byte-identical.
//
// Usage: node scripts/scan_module_meta.mjs
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { tableNamesIn } from "./parse_proof_schema.mjs";
import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

// Module packages have no `"type"` field, so importing a `.ts` file out of one
// makes Node warn that it had to reparse as ESM. Adding `"type": "module"` to
// thirteen package.json files to silence it would change how the bundler reads
// them, which is a real risk traded for a cosmetic one. Filter the warning
// instead, and let every other warning through untouched.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(warning.stack ?? String(warning));
});

const DESCRIPTOR = "module.meta.ts";
const OUTPUT_PATH = CONFIG.artifacts.modules;
const CAPABILITIES_PATH = CONFIG.artifacts.capabilities;
const MUTATION_HARNESS = CONFIG.mutationCatalog;
const PROOFS_DIR = CONFIG.roots.proofs;

/** Roots whose children are modules a planner can reason about. */
const MODULE_ROOTS = CONFIG.roots.modules;

/** Utilities. They own tables but are never installed, so they carry no descriptor. */
const SHARED_ROOT = CONFIG.roots.sharedModules;

/**
 * One module importing another, in any of the forms the codebase uses:
 * `from "@core/x/…"`, `export … from "@shared/x/…"`, `import("@extensions/x/…")`.
 * Matching the quoted specifier rather than the keyword catches all three.
 */
const IMPORT_PATTERN =
  /["']@(core|shared|extensions|business)\/([a-zA-Z0-9._-]+)/g;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function normalize(value) {
  return value.split(path.sep).join("/");
}

function directoriesIn(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Every module directory, whether or not it has a descriptor yet. */
function allModuleDirs() {
  const found = [];
  for (const root of MODULE_ROOTS) {
    for (const name of directoriesIn(root)) {
      found.push({ id: name, dir: path.join(root, name), root });
    }
  }
  return found;
}

function describedModules() {
  return allModuleDirs().filter((m) =>
    fs.existsSync(path.join(m.dir, DESCRIPTOR)),
  );
}

// ---------------------------------------------------------------------------
// The declared half
// ---------------------------------------------------------------------------

/**
 * Read one descriptor.
 *
 * A descriptor is TypeScript so a wrong shape is a compile error under
 * `pnpm typecheck` rather than a runtime surprise. Reading it here needs no
 * loader — see the header.
 */
async function readDescriptor(file) {
  const url = pathToFileURL(path.resolve(file)).href;
  const mod = await import(url);
  if (!mod.meta) {
    throw new Error(`${normalize(file)} does not export \`meta\``);
  }
  return mod.meta;
}

// ---------------------------------------------------------------------------
// The derived half
// ---------------------------------------------------------------------------

function sqlFilesIn(dir) {
  const migrations = path.join(dir, "src", "db", "migrations");
  if (!fs.existsSync(migrations)) return [];
  return fs
    .readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(migrations, f));
}

/** Tables this module's own migrations create. */
function tablesOwnedBy(dir) {
  const tables = new Set();
  for (const file of sqlFilesIn(dir)) {
    for (const name of tableNamesIn(fs.readFileSync(file, "utf8"))) {
      tables.add(name);
    }
  }
  return [...tables].sort();
}

function sourceFilesIn(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        // Tests import freely to build fixtures. That is a dependency of
        // testing the module, not a dependency of the module.
        if (entry.name === "__tests" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && entry.name !== DESCRIPTOR) {
        out.push(full);
      }
    }
  };
  walk(path.join(dir, "src"));
  return out.sort();
}

/**
 * Which modules this one imports, split by whether they are installable.
 *
 * `requires` is what a planner has to order a build around. `uses_shared` is
 * reported separately because a shared utility is not something anyone
 * installs, prices, or can be offered — putting it in `requires` would make
 * every module look like it depends on twelve things.
 */
function importsOf(dir, id, realModuleIds) {
  const requires = new Set();
  const shared = new Set();
  for (const file of sourceFilesIn(dir)) {
    const source = fs.readFileSync(file, "utf8");
    IMPORT_PATTERN.lastIndex = 0;
    let m;
    while ((m = IMPORT_PATTERN.exec(source)) !== null) {
      const [, alias, name] = m;
      if (alias === "shared") {
        shared.add(name);
        continue;
      }
      if (name === id) continue;
      // Only real directories. A typo'd alias is a build error, not a
      // dependency, and inventing a node for it would corrupt the graph.
      if (realModuleIds.has(name)) requires.add(name);
    }
  }
  return {
    requires: [...requires].sort(),
    uses_shared: [...shared].sort(),
  };
}

/** What this module can be asked to do, from the capability scan. */
function actionsFor(id) {
  if (!fs.existsSync(CAPABILITIES_PATH)) return [];
  const { capabilities = [] } = JSON.parse(
    fs.readFileSync(CAPABILITIES_PATH, "utf8"),
  );
  return capabilities
    .filter((c) => c.module === id)
    .map((c) => ({ name: c.name, verb: c.verb, object: c.object }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How battle-tested this module is.
 *
 * Derived rather than claimed, because "this module is well tested" is exactly
 * the sentence nobody updates downwards.
 *
 * The mutation count is read out of the harness as text, which is the one piece
 * of scraping left in this file. Importing `proof_mutation_check.mjs` for its
 * `MUTATIONS` array would be more honest and would drag `@next/env` into a
 * script that has to stay dependency-free (see the header). The scrape is
 * anchored to the table map derived above, so it cannot drift silently in the
 * way a hand-written count would — but it is the first thing to revisit if the
 * harness ever grows a machine-readable inventory.
 */
function provenFor(tables, actions) {
  let specs = 0;
  if (fs.existsSync(PROOFS_DIR)) {
    const targets = [...tables, ...actions.map((a) => a.name)];
    for (const file of fs.readdirSync(PROOFS_DIR).sort()) {
      if (!file.endsWith(".proof.ts")) continue;
      const source = fs.readFileSync(path.join(PROOFS_DIR, file), "utf8");
      if (targets.some((t) => source.includes(t))) specs += 1;
    }
  }

  let mutations = 0;
  if (MUTATION_HARNESS && fs.existsSync(MUTATION_HARNESS)) {
    const owned = new Set(tables);
    const source = fs.readFileSync(MUTATION_HARNESS, "utf8");
    for (const line of source.split("\n")) {
      const m = line.match(/table:\s*"public\.([a-z_]+)"/);
      if (m && owned.has(m[1])) mutations += 1;
    }
  }

  return { specs, mutations };
}

/**
 * Tables nobody's descriptor claims.
 *
 * Today these are the `__shared` modules' own tables — `audit_logs` and
 * `rate_limit_counters`. Listed rather than omitted: a planner that cannot see
 * `audit_logs` will eventually promise to build it.
 */
function unownedTables(claimed) {
  const rows = [];
  for (const name of directoriesIn(SHARED_ROOT)) {
    const dir = path.join(SHARED_ROOT, name);
    for (const table of tablesOwnedBy(dir)) {
      if (claimed.has(table)) continue;
      rows.push({ table, module: name, path: normalize(dir) });
    }
  }
  return rows.sort((a, b) => a.table.localeCompare(b.table));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const realModuleIds = new Set(allModuleDirs().map((m) => m.id));
  const described = describedModules();
  const scanned = [];

  for (const { id, dir } of described) {
    const declared = await readDescriptor(path.join(dir, DESCRIPTOR));
    const entities = tablesOwnedBy(dir);
    const actions = actionsFor(id);
    const { requires, uses_shared } = importsOf(dir, id, realModuleIds);

    scanned.push({
      ...declared,
      path: normalize(dir),
      entities,
      requires,
      uses_shared,
      actions,
      proven: provenFor(entities, actions),
    });
  }

  scanned.sort((a, b) => a.id.localeCompare(b.id));

  const claimed = new Set(scanned.flatMap((m) => m.entities));
  const payload = {
    schemaVersion: 1,
    modules: scanned,
    unowned_tables: unownedTables(claimed),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );

  const undescribed = realModuleIds.size - described.length;
  console.log(
    `[proof:modules] scanned ${described.length} module descriptor(s), ` +
      `${undescribed} module(s) without one, ` +
      `${payload.unowned_tables.length} unowned table(s); wrote ${OUTPUT_PATH}`,
  );
}

// Only run the CLI when executed directly, so importing this module for tests
// has no side effects.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[proof:modules] unexpected error: ${err?.stack ?? err}`);
    process.exit(2);
  });
}

export { main };
