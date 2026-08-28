#!/usr/bin/env node
// ---------------------------------------------------------------------------
// proof_module_check.mjs
//
// Checks every claim a module descriptor makes against the code.
//
// A descriptor is a hand-written claim about a codebase, and hand-written
// claims about code go stale silently. That is the failure this whole repo
// keeps meeting — a wrong answer indistinguishable from a right one at the
// point it is produced — so the claims are checked rather than believed.
//
// Most of what the downstream prototype declared is now derived instead
// (tables, dependencies, actions), which deletes those checks rather than
// implementing them: you cannot mis-declare what you do not declare. What is
// left is the part no compiler knows, and each piece of it is checkable:
//
//   module_missing        every core/extension module HAS a descriptor. The one
//                         that matters most — without it, deleting a descriptor
//                         makes every other check on that module vanish and CI
//                         stays green. A module may instead be accepted as
//                         undescribed in .proof/module-policy.json with a
//                         written reason (module_policy / module_policy_stale
//                         guard that file), so an adopting consumer pays the
//                         descriptor debt down module by module instead of
//                         switching the check off.
//   module_identity       id matches its directory; kind matches its root
//   module_shape          the descriptor is actually the shape it claims
//   module_question_shape ids unique and snake_case, options real and distinct,
//                         applied_by in the closed vocabulary
//   module_seam_missing   every place an answer lands still exists. This is what
//                         stops a moved file from quietly misleading the code
//                         agent that has to apply the answer.
//   module_env_undocumented   declared env vars are in .env.local.example
//   module_env_undeclared     env vars the module reads are declared
//
// Cycles in the derived dependency graph are REPORTED, not failed — the known
// one is being fixed elsewhere. Promote to a failure once it lands.
//
// Exits non-zero on any mismatch. A descriptor that can be wrong silently is a
// liability with a nice format.
//
// Usage: node scripts/proof_module_check.mjs [--json]
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

// See the same filter in scan_module_meta.mjs. It has to be installed before
// anything imports a `.ts` file, which is why the vocabulary below is imported
// dynamically inside main() rather than at the top: a static import would be
// hoisted above this and warn before the handler exists.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  console.warn(warning.stack ?? String(warning));
});

const MODULES_PATH = CONFIG.artifacts.modules;
const ENV_EXAMPLE = CONFIG.repository.envExample;
const MODULE_POLICY_PATH = CONFIG.policies.module;
const DESCRIPTOR = "module.meta.ts";

/** Roots that must carry a descriptor, and the kind each implies. */
const REQUIRED_ROOTS = CONFIG.moduleKinds.required;
const OPTIONAL_ROOTS = CONFIG.moduleKinds.optional;

const ENV_READ_PATTERN = /(?:process\.)?env\.([A-Z][A-Z0-9_]+)/g;
/** Set by the runtime, not by whoever installs the product. */
const ENV_IGNORED = new Set(["NODE_ENV"]);

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PURPOSE_MAX = 400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function directoriesIn(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function documentedEnv() {
  if (!fs.existsSync(ENV_EXAMPLE)) return new Set();
  return new Set(
    fs
      .readFileSync(ENV_EXAMPLE, "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
      .filter(Boolean),
  );
}

function sourceFilesIn(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && entry.name !== DESCRIPTOR) {
        out.push(full);
      }
    }
  };
  walk(path.join(dir, "src"));
  return out;
}

/**
 * Resolve one seam.
 *
 * `path/to/file.ts` must exist. `path/to/file.ts#SYMBOL` must exist AND contain
 * that identifier — deliberately "appears in the file" rather than "is
 * exported", because the seams that matter most are not always exports:
 * `FOOTER_NAVIGATION_LINKS` is a local inside a component body, and it is still
 * exactly where the answer lands.
 */
function seamProblem(seam) {
  const [file, symbol] = seam.split("#");
  if (!fs.existsSync(file)) {
    return `expected a file at ${file}, found nothing`;
  }
  if (!symbol) return null;
  if (fs.statSync(file).isDirectory()) {
    return `expected ${file} to be a file so "${symbol}" could be looked up in it, found a directory`;
  }
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(symbol)) {
    return `expected "${symbol}" in ${file}, found no mention of it`;
  }
  return null;
}

/**
 * Mutually dependent clusters in the derived `requires` graph, via Tarjan.
 *
 * Components rather than cycles, and the difference is not cosmetic: walking
 * every distinct cycle in this graph enumerates hundreds of permutations of the
 * same handful of modules and buries the finding in its own output. "These five
 * modules cannot be ordered relative to each other" is the fact worth having,
 * and there is one of those per cluster.
 */
function findCycles(modules) {
  const edges = new Map(modules.map((m) => [m.id, m.requires ?? []]));
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let next = 0;

  const strongConnect = (id) => {
    index.set(id, next);
    low.set(id, next);
    next += 1;
    stack.push(id);
    onStack.add(id);

    for (const to of edges.get(id) ?? []) {
      if (!edges.has(to)) continue;
      if (!index.has(to)) {
        strongConnect(to);
        low.set(id, Math.min(low.get(id), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(id, Math.min(low.get(id), index.get(to)));
      }
    }

    if (low.get(id) !== index.get(id)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== id);

    const selfReferential = (edges.get(id) ?? []).includes(id);
    if (component.length > 1 || selfReferential)
      components.push(component.sort());
  };

  for (const m of modules) if (!index.has(m.id)) strongConnect(m.id);
  return components.sort(
    (a, b) => b.length - a.length || a[0].localeCompare(b[0]),
  );
}

// ---------------------------------------------------------------------------
// Module policy
//
// A consumer adopting the package with existing undescribed modules would
// otherwise face an all-or-nothing gate: write every considered descriptor
// before the check can pass once, or switch the check off — and a check that
// is off finds nothing at all. `.proof/module-policy.json` turns the wall
// into the same ratchet coverage uses: a module may be accepted as
// undescribed WITH a written reason, the listing is the visible backlog, and
// an entry that no longer applies fails as stale so paid-down debt leaves
// the file.
// ---------------------------------------------------------------------------

function readModulePolicy(policyPath) {
  const empty = { acceptedUndescribed: [] };
  if (!fs.existsSync(policyPath)) return { policy: empty, problems: [] };
  try {
    const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    if (policy.schemaVersion !== 1) {
      return {
        policy: empty,
        problems: [
          {
            category: "module_policy",
            message: `${policyPath} has unsupported schemaVersion ${policy.schemaVersion ?? "<missing>"}; expected 1.`,
          },
        ],
      };
    }
    return { policy, problems: [] };
  } catch (error) {
    return {
      policy: empty,
      problems: [
        {
          category: "module_policy",
          message: `cannot read ${policyPath}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/**
 * Judge every undescribed module against the accepted-undescribed policy.
 *
 * `missing` is `[{ root, name, kind }]` for required-root modules without a
 * descriptor; `described` is the set of module ids that have one. Returns the
 * problems to report and the acceptances that applied, so the caller can make
 * the surviving debt visible without opening the file.
 */
export function evaluateModulePolicy({
  missing,
  described,
  policy,
  policyPath,
  descriptor = DESCRIPTOR,
}) {
  const problems = [];
  const entries = Array.isArray(policy?.acceptedUndescribed)
    ? policy.acceptedUndescribed
    : [];

  const byModule = new Map();
  for (const entry of entries) {
    if (
      typeof entry?.module !== "string" ||
      typeof entry?.reason !== "string" ||
      entry.reason.trim() === ""
    ) {
      problems.push({
        category: "module_policy",
        message: `${policyPath}: every acceptedUndescribed entry needs a "module" path and a non-empty "reason", found ${JSON.stringify(entry)}. An acceptance without a written reason is not a decision anybody can revisit.`,
      });
      continue;
    }
    if (byModule.has(entry.module)) {
      problems.push({
        category: "module_policy",
        message: `${policyPath}: duplicate acceptedUndescribed entry for "${entry.module}".`,
      });
      continue;
    }
    byModule.set(entry.module, entry);
  }

  const accepted = [];
  const usedModules = new Set();
  for (const { root, name, kind } of missing) {
    const key = `${root}/${name}`;
    const acceptance = byModule.get(key);
    if (acceptance) {
      usedModules.add(key);
      accepted.push(acceptance);
      continue;
    }
    problems.push({
      category: "module_missing",
      message: `expected ${root}/${name}/${descriptor} to exist, found nothing. Without a descriptor this module is invisible to a planner, and every other check on it silently does not run.`,
      suggestion:
        `Add ${root}/${name}/${descriptor} declaring at least id, kind and purpose (kind: "${kind}"), ` +
        `or record the module in ${policyPath} under acceptedUndescribed with a durable reason — the listing is the backlog.`,
    });
  }

  const describedIds = new Set(described);
  for (const [key, entry] of byModule) {
    if (usedModules.has(key)) continue;
    const basename = key.split("/").at(-1);
    const why = describedIds.has(basename)
      ? "the module now has a descriptor — delete the acceptance"
      : "no required-root module directory matches that path — delete or fix the acceptance";
    problems.push({
      category: "module_policy_stale",
      message: `${policyPath}: acceptance for "${entry.module}" no longer applies: ${why}.`,
    });
  }

  return { problems, accepted };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkCoverage(modules, policyResult, problems) {
  const described = new Set(modules.map((m) => m.id));
  const missing = [];
  for (const { root, kind } of REQUIRED_ROOTS) {
    for (const name of directoriesIn(root)) {
      if (described.has(name)) continue;
      missing.push({ root, name, kind });
    }
  }
  const outcome = evaluateModulePolicy({
    missing,
    described,
    policy: policyResult.policy,
    policyPath: MODULE_POLICY_PATH,
  });
  problems.push(...policyResult.problems, ...outcome.problems);
  return outcome.accepted;
}

function checkIdentity(mod, problems) {
  const where = `${mod.path}/${DESCRIPTOR}`;

  if (!mod.path?.endsWith(`/${mod.id}`)) {
    problems.push({
      category: "module_identity",
      message: `${where}: expected id to match the directory it sits in, found id "${mod.id}" at ${mod.path}.`,
    });
  }

  const roots = [...REQUIRED_ROOTS, ...OPTIONAL_ROOTS];
  const expected = roots.find((r) => mod.path?.startsWith(`${r.root}/`))?.kind;
  if (expected && mod.kind !== expected && mod.kind !== "generated") {
    problems.push({
      category: "module_identity",
      message: `${where}: expected kind "${expected}" for a module under ${mod.path}, found "${mod.kind}". A planner prices core, extension and generated very differently.`,
    });
  }
}

function checkShape(mod, MODULE_KINDS, problems) {
  const where = `${mod.path}/${DESCRIPTOR}`;
  const bad = (message) => problems.push({ category: "module_shape", message });

  if (!MODULE_KINDS.includes(mod.kind)) {
    bad(
      `${where}: expected kind to be one of ${MODULE_KINDS.join(" | ")}, found ${JSON.stringify(mod.kind)}.`,
    );
  }
  if (typeof mod.purpose !== "string" || mod.purpose.trim() === "") {
    bad(
      `${where}: expected a purpose a buyer would recognise, found ${JSON.stringify(mod.purpose)}. It is the field a planner leans on hardest and the only one nothing else can verify.`,
    );
  } else if (mod.purpose.length > PURPOSE_MAX) {
    bad(
      `${where}: expected purpose under ${PURPOSE_MAX} characters, found ${mod.purpose.length}. A planner reads every one of these; a paragraph here is a paragraph in every plan.`,
    );
  }
  for (const field of ["env", "decisions", "inputs", "defaults"]) {
    if (!Array.isArray(mod[field])) {
      bad(
        `${where}: expected ${field} to be an array, found ${JSON.stringify(mod[field])}. Declare it empty rather than omitting it — an empty list is an answer, a missing one is a gap.`,
      );
    }
  }
}

function checkQuestions(mod, APPLIED_BY, seenIds, problems) {
  const where = `${mod.path}/${DESCRIPTOR}`;
  const bad = (message, suggestion) =>
    problems.push({ category: "module_question_shape", message, suggestion });

  const claimId = (id, kind) => {
    if (typeof id !== "string" || !SNAKE_CASE.test(id)) {
      bad(
        `${where}: expected a snake_case id on a ${kind}, found ${JSON.stringify(id)}.`,
      );
      return;
    }
    if (seenIds.has(id)) {
      bad(
        `${where}: expected id "${id}" to be unique across every module, found it already used by ${seenIds.get(id)}. A planner keys the buyer's answers by this id, so a duplicate silently overwrites one of them.`,
      );
      return;
    }
    seenIds.set(id, where);
  };

  for (const d of mod.decisions ?? []) {
    claimId(d.id, "decision");
    if (!APPLIED_BY.includes(d.applied_by)) {
      bad(
        `${where}: decision "${d.id}" expected applied_by to be one of ${APPLIED_BY.join(" | ")}, found ${JSON.stringify(d.applied_by)}. It is the planner's only cost signal.`,
      );
    }
    const options = d.options ?? [];
    if (options.length < 2) {
      bad(
        `${where}: decision "${d.id}" expected at least 2 options, found ${options.length}. A question with one answer is a default — move it to defaults[].`,
      );
    }
    const values = options.map((o) => o.value);
    if (new Set(values).size !== values.length) {
      bad(
        `${where}: decision "${d.id}" expected distinct option values, found duplicates in [${values.join(", ")}].`,
      );
    }
    for (const o of options) {
      if (typeof o.means !== "string" || o.means.trim() === "") {
        bad(
          `${where}: decision "${d.id}" option "${o.value}" expected a plain-language "means", found nothing. A buyer cannot pick between values they have no description of.`,
        );
      }
    }
    for (const field of ["ask", "because"]) {
      if (typeof d[field] !== "string" || d[field].trim() === "") {
        bad(`${where}: decision "${d.id}" expected a ${field}, found nothing.`);
      }
    }
  }

  for (const i of mod.inputs ?? []) {
    claimId(i.id, "input");
    for (const field of ["ask", "because", "example"]) {
      if (typeof i[field] !== "string" || i[field].trim() === "") {
        bad(`${where}: input "${i.id}" expected a ${field}, found nothing.`);
      }
    }
    if (typeof i.required !== "boolean") {
      bad(
        `${where}: input "${i.id}" expected required to be a boolean, found ${JSON.stringify(i.required)}. It is how a planner knows whether it can start without an answer.`,
      );
    }
  }

  for (const f of mod.defaults ?? []) {
    claimId(f.id, "default");
    if (typeof f.is !== "string" || f.is.trim() === "") {
      bad(
        `${where}: default "${f.id}" expected an "is" describing what the template does, found nothing.`,
      );
    }
  }
}

function checkSeams(mod, problems) {
  const where = `${mod.path}/${DESCRIPTOR}`;
  const seams = [
    ...(mod.decisions ?? []).flatMap((d) =>
      (d.applies ?? []).map((s) => [`decision "${d.id}"`, s]),
    ),
    ...(mod.inputs ?? []).flatMap((i) =>
      (i.applies ?? []).map((s) => [`input "${i.id}"`, s]),
    ),
    ...(mod.defaults ?? [])
      .filter((f) => f.where)
      .map((f) => [`default "${f.id}"`, f.where]),
  ];

  for (const [owner, seam] of seams) {
    const problem = seamProblem(seam);
    if (!problem) continue;
    problems.push({
      category: "module_seam_missing",
      message: `${where}: ${owner} says its answer lands at ${seam}, but ${problem}.`,
      suggestion:
        "Either the file moved and the seam needs updating, or the answer no longer lands there. A seam nobody checks sends the agent applying the answer to the wrong place, and it will not notice.",
    });
  }
}

function checkEnv(mod, documented, problems) {
  const where = `${mod.path}/${DESCRIPTOR}`;
  const declared = new Set(mod.env ?? []);

  for (const key of declared) {
    if (documented.has(key)) continue;
    problems.push({
      category: "module_env_undocumented",
      message: `${where}: expected ${key} in ${ENV_EXAMPLE}, found nothing. Somebody installing this module has no way to learn it is needed until it fails at runtime.`,
    });
  }

  const read = new Set();
  for (const file of sourceFilesIn(mod.path)) {
    const source = fs.readFileSync(file, "utf8");
    ENV_READ_PATTERN.lastIndex = 0;
    let m;
    while ((m = ENV_READ_PATTERN.exec(source)) !== null) {
      if (!ENV_IGNORED.has(m[1])) read.add(m[1]);
    }
  }
  for (const key of [...read].sort()) {
    if (declared.has(key)) continue;
    problems.push({
      category: "module_env_undeclared",
      message: `${where}: expected ${key} to be declared in env, found it read in this module's source but not declared. This is the direction nobody checks: the module works on the machine that already has the variable set, and fails on every other one.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { APPLIED_BY, MODULE_KINDS } = await import("../../dist/shared.js");
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const unknown = args.filter((a) => !["--json"].includes(a));
  if (unknown.length > 0) {
    console.error(`[proof:modules:check] unknown flag: ${unknown.join(", ")}`);
    process.exit(2);
  }

  if (!fs.existsSync(MODULES_PATH)) {
    console.error(
      `[PROOF_FAIL] module_missing: expected ${MODULES_PATH}, found nothing.\n` +
        "  suggestion: Run `pnpm proof:modules` first — it is a derived artifact and is not committed.\n",
    );
    process.exit(1);
  }

  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(MODULES_PATH, "utf8"));
  } catch (err) {
    console.error(
      `[proof:modules:check] ${MODULES_PATH} is not valid JSON: ${err.message}`,
    );
    process.exit(2);
  }

  const modules = artifact.modules ?? [];
  const documented = documentedEnv();
  const seenIds = new Map();
  const problems = [];

  const acceptedUndescribed = checkCoverage(
    modules,
    readModulePolicy(MODULE_POLICY_PATH),
    problems,
  );
  for (const mod of modules) {
    checkIdentity(mod, problems);
    checkShape(mod, MODULE_KINDS, problems);
    checkQuestions(mod, APPLIED_BY, seenIds, problems);
    checkSeams(mod, problems);
    checkEnv(mod, documented, problems);
  }

  const cycles = findCycles(modules);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          modules: modules.length,
          acceptedUndescribed,
          problems,
          cycles,
        },
        null,
        2,
      ),
    );
  }

  if (problems.length > 0) {
    if (!asJson) {
      console.error(
        `\n[proof:modules:check] ${problems.length} claim(s) the code does not support.\n`,
      );
      for (const p of problems) {
        console.error(`[PROOF_FAIL] ${p.category}: ${p.message}`);
        if (p.suggestion) console.error(`  suggestion: ${p.suggestion}`);
        console.error("");
      }
    }
    process.exit(1);
  }

  if (asJson) return;

  const decisions = modules.reduce((n, m) => n + (m.decisions?.length ?? 0), 0);
  const inputs = modules.reduce((n, m) => n + (m.inputs?.length ?? 0), 0);
  const defaults = modules.reduce((n, m) => n + (m.defaults?.length ?? 0), 0);

  // Reported, never failed, while the inversion is fixed elsewhere. Printed on
  // stdout and without the failure token, so nothing greps this as a break.
  for (const cluster of cycles) {
    console.log(
      `[proof:modules:check] note: ${cluster.length} modules depend on each other ` +
        `and cannot be ordered relative to one another — ${cluster.join(", ")}.`,
    );
  }

  if (acceptedUndescribed.length > 0) {
    console.log(
      `[proof:modules:check] ${acceptedUndescribed.length} module(s) accepted as undescribed by ${MODULE_POLICY_PATH} — that listing is the backlog:`,
    );
    for (const entry of acceptedUndescribed) {
      console.log(`  - ${entry.module}: ${entry.reason}`);
    }
  }

  console.log(
    `[proof:modules:check] ${modules.length} module descriptor(s) verified against source: ` +
      `${decisions} decision(s), ${inputs} input(s), ${defaults} default(s), ` +
      `${artifact.unowned_tables?.length ?? 0} unowned table(s), ` +
      `${acceptedUndescribed.length} accepted undescribed module(s).`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(
      `[proof:modules:check] unexpected error: ${err?.stack ?? err}`,
    );
    process.exit(2);
  });
}

export { main, seamProblem, findCycles, readModulePolicy };
