import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONFIG = Object.freeze({
  artifacts: {
    capabilities: ".proof/capabilities.json",
    schema: ".proof/schema.json",
    modules: ".proof/modules.json",
    traces: ".proof/traces",
    drift: ".proof/drift.json",
    mutations: ".proof/mutations",
  },
  mission: {
    current: ".proof/current-mission.json",
    directory: ".proof/missions",
  },
  policies: {
    coverage: ".proof/coverage-policy.json",
    mutation: ".proof/mutation-policy.json",
    migration: ".proof/migration-policy.json",
    module: ".proof/module-policy.json",
  },
  roots: {
    source: "app",
    actions: ["app/__core", "app/__business-logic", "app/__extensions"],
    modules: ["app/__core", "app/__extensions", "app/__business-logic"],
    sharedModules: "app/__shared",
    proofs: "e2e/proofs",
    fixtures: "e2e/fixtures",
    migrations: "supabase/migrations",
  },
  registryOutput: "app/__shared/proof-runtime/action-registry.generated.ts",
  registryAliases: {
    "app/__core/": "@core/",
    "app/__business-logic/": "@business/",
    "app/__extensions/": "@extensions/",
  },
  repository: {
    packageJson: "package.json",
    lockfile: "pnpm-lock.yaml",
    envExample: ".env.local.example",
    supabaseConfig: "supabase/config.toml",
  },
  moduleKinds: {
    required: [
      { root: "app/__core", kind: "core" },
      { root: "app/__extensions", kind: "extension" },
    ],
    optional: [{ root: "app/__business-logic", kind: "business" }],
  },
  driftSources: ["app", "package.json"],
  mutationCatalog: null,
});

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    artifacts: { ...DEFAULT_CONFIG.artifacts, ...config.artifacts },
    mission: { ...DEFAULT_CONFIG.mission, ...config.mission },
    policies: { ...DEFAULT_CONFIG.policies, ...config.policies },
    roots: { ...DEFAULT_CONFIG.roots, ...config.roots },
    repository: { ...DEFAULT_CONFIG.repository, ...config.repository },
    registryAliases: {
      ...DEFAULT_CONFIG.registryAliases,
      ...config.registryAliases,
    },
    moduleKinds: {
      ...DEFAULT_CONFIG.moduleKinds,
      ...config.moduleKinds,
    },
  };
}

export async function loadProofConfig({
  cwd = process.cwd(),
  configPath = process.env.PROOF_HARNESS_CONFIG,
} = {}) {
  const requested = configPath
    ? path.resolve(cwd, configPath)
    : path.resolve(cwd, "proof.config.mjs");
  let supplied = {};
  if (fs.existsSync(requested)) {
    const loaded = await import(pathToFileURL(requested).href);
    supplied = loaded.default ?? loaded.proofConfig ?? {};
  } else if (configPath) {
    throw new Error(`proof config not found: ${requested}`);
  }

  const rootDir = path.resolve(
    path.dirname(
      fs.existsSync(requested)
        ? requested
        : path.resolve(cwd, "proof.config.mjs"),
    ),
    supplied.rootDir ?? ".",
  );
  return {
    ...mergeConfig(supplied),
    rootDir,
    configPath: fs.existsSync(requested) ? requested : null,
  };
}

export async function loadMutationCatalog(config) {
  if (!config.mutationCatalog) return [];
  const file = path.resolve(config.rootDir, config.mutationCatalog);
  const loaded = await import(pathToFileURL(file).href);
  const mutations = loaded.mutations ?? loaded.default;
  if (!Array.isArray(mutations)) {
    throw new Error(`${config.mutationCatalog} must export a mutations array`);
  }
  return mutations;
}

export { DEFAULT_CONFIG };
