#!/usr/bin/env node
// Generate the dev/test-only server-action allowlist from current proof intent.
//
// Registration sources:
//   1. withProof invariants declared in capabilities.json
//   2. derived workspace-scoped service-role mutation requirements
//   3. literal action probes in e2e/proofs/*.proof.ts
//
// The generated TypeScript file is committed. Fresh checkout build/typecheck
// jobs do not run proof:build, so gitignoring source required by the invoke
// route would make the repository uncompilable before setup.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const CAPABILITIES_PATH = CONFIG.artifacts.capabilities;
const PROOFS_DIR = CONFIG.roots.proofs;
const OUTPUT_PATH = CONFIG.registryOutput;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

function proofFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".proof.ts"))
        files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

function literal(body, property) {
  return body.match(new RegExp(`\\b${property}\\s*:\\s*["']([^"']+)["']`))?.[1];
}

export function scanProofActionRefs(source) {
  const clean = stripComments(source);
  const refs = new Set();

  for (const match of clean.matchAll(/\baction\s*:\s*\{([\s\S]*?)\}/g)) {
    const moduleName = literal(match[1], "module");
    const actionName = literal(match[1], "name");
    if (moduleName && actionName) refs.add(`${moduleName}:${actionName}`);
  }

  for (const match of clean.matchAll(
    /\binvokeAction\s*\([\s\S]*?,\s*\{([\s\S]*?)\}\s*\)/g,
  )) {
    const moduleName = literal(match[1], "module");
    const actionName = literal(match[1], "action");
    if (moduleName && actionName) refs.add(`${moduleName}:${actionName}`);
  }

  return [...refs].sort();
}

function importPath(file) {
  const normalized = file.split(path.sep).join("/").replace(/\.ts$/, "");
  const mappings = Object.entries(CONFIG.registryAliases);
  for (const [prefix, alias] of mappings) {
    if (normalized.startsWith(prefix)) {
      return `${alias}${normalized.slice(prefix.length)}`;
    }
  }
  throw new Error(
    `action file "${file}" is outside the supported module roots`,
  );
}

function localName(ref) {
  return `proofAction_${ref.replace(/[^A-Za-z0-9_$]/g, "_")}`;
}

/**
 * @param {{
 *   capabilities: { capabilities?: Array<{
 *     name: string;
 *     module: string;
 *     exportName?: string | null;
 *     invariants?: string[];
 *     acceptsWorkspaceId?: boolean;
 *     internalOnly?: boolean;
 *     serviceRoleMutations?: Array<{ table: string; operation: string }>;
 *     file: string;
 *   }> };
 *   proofSources?: Array<{ file: string; source: string }>;
 * }} input
 */
export function buildRegistry({ capabilities, proofSources = [] }) {
  const byRef = new Map(
    (capabilities.capabilities ?? []).map((capability) => [
      `${capability.module}:${capability.name}`,
      capability,
    ]),
  );
  const registrations = new Map();

  const add = (ref, source) => {
    if (!registrations.has(ref)) registrations.set(ref, new Set());
    registrations.get(ref).add(source);
  };

  for (const capability of capabilities.capabilities ?? []) {
    const ref = `${capability.module}:${capability.name}`;
    if ((capability.invariants ?? []).length > 0) add(ref, "explicit_claim");
    if (
      capability.acceptsWorkspaceId === true &&
      capability.internalOnly !== true &&
      (capability.serviceRoleMutations ?? []).length > 0
    ) {
      add(ref, "derived_service_role");
    }
  }

  for (const { file, source } of proofSources) {
    for (const ref of scanProofActionRefs(source)) add(ref, `proof:${file}`);
  }

  const entries = [];
  const problems = [];
  for (const [ref, sources] of [...registrations.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const capability = byRef.get(ref);
    if (!capability) {
      problems.push(
        `${ref} is referenced by ${[...sources].sort().join(", ")} but no scanned createAction capability has that ref`,
      );
      continue;
    }
    if (!capability.exportName) {
      problems.push(
        `${ref} is selected for proof invocation but ${capability.file} has no literal exported function`,
      );
      continue;
    }
    if (capability.usesDirectUpdateTag === true) {
      problems.push(
        `${ref} imports updateTag directly from next/cache; registry actions must use updateTagSafe so Route Handler invocation preserves production semantics without throwing in proof mode`,
      );
      continue;
    }
    try {
      entries.push({
        ref,
        exportName: capability.exportName,
        importPath: importPath(capability.file),
        localName: localName(ref),
        sources: [...sources].sort(),
      });
    } catch (error) {
      problems.push(
        `${ref} cannot be registered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { entries, problems };
}

export function renderRegistry(entries) {
  const imports = entries.map(
    (entry) =>
      `import { ${entry.exportName} as ${entry.localName} } from "${entry.importPath}";`,
  );
  const rows = entries.flatMap((entry) => [
    `  "${entry.ref}":`,
    `    ${entry.localName} as unknown as ProofActionHandler,`,
  ]);

  return [
    "// AUTO-GENERATED by scripts/generate_proof_action_registry.mjs.",
    "// Do not edit by hand; run `pnpm proof:registry`.",
    "",
    ...imports,
    ...(imports.length > 0 ? [""] : []),
    'import type { ProofActionHandler } from "@saasist/proof/server";',
    "",
    "export const PROOF_ACTION_REGISTRY: Record<string, ProofActionHandler> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}

export function generateRegistry({
  rootDir = process.cwd(),
  check = false,
} = {}) {
  const capabilities = readJson(path.join(rootDir, CAPABILITIES_PATH));
  const sources = proofFiles(path.join(rootDir, PROOFS_DIR)).map((file) => ({
    file: path.relative(rootDir, file).split(path.sep).join("/"),
    source: fs.readFileSync(file, "utf8"),
  }));
  const { entries, problems } = buildRegistry({
    capabilities,
    proofSources: sources,
  });
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`[proof:registry] ${problem}`);
    }
    throw new Error(
      `[PROOF_FAIL] action_registry: ${problems.length} registration problem(s)`,
    );
  }

  const output = renderRegistry(entries);
  const outputFile = path.join(rootDir, OUTPUT_PATH);
  const current = fs.existsSync(outputFile)
    ? fs.readFileSync(outputFile, "utf8")
    : null;

  if (check) {
    if (current !== output) {
      throw new Error(
        `[PROOF_FAIL] action_registry_stale: ${OUTPUT_PATH} does not match current actions and proofs\n` +
          "  suggestion: run `pnpm proof:registry` and commit the generated file",
      );
    }
  } else {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, output, "utf8");
  }

  console.log(
    `[proof:registry] ${check ? "verified" : "wrote"} ${entries.length} action(s) in ${OUTPUT_PATH}`,
  );
  return entries;
}

function parseArgs(argv) {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    throw new Error(`unknown flag(s): ${unknown.join(", ")}`);
  }
  return { check: argv.includes("--check") };
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    generateRegistry(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
