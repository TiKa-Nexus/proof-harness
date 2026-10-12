import fs from "node:fs";
import path from "node:path";
import { isArtifactId, readTraceDirectory } from "../../dist/node.js";
import { evidenceExclusions } from "../config.mjs";
import { validateControlBaseline } from "./proof_control_sensitivity.mjs";
import {
  deriveAutomaticRlsMutations,
  evaluateMutationClaimCoverage,
  mutationCoversClaim,
} from "./proof_mutation_inventory.mjs";

function readMutationPolicy(MUTATION_POLICY_PATH) {
  try {
    const policy = JSON.parse(fs.readFileSync(MUTATION_POLICY_PATH, "utf8"));
    if (policy.schemaVersion !== 1) {
      return {
        policy: { acceptedClaims: [] },
        problems: [
          `${MUTATION_POLICY_PATH} has unsupported schemaVersion ${policy.schemaVersion ?? "<missing>"}; expected 1`,
        ],
      };
    }
    return { policy, problems: [] };
  } catch (error) {
    return {
      policy: { acceptedClaims: [] },
      problems: [
        `cannot read ${MUTATION_POLICY_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export function buildMutationInventory({
  config: CONFIG,
  mutations: catalog,
  controlSensitivity: CONTROL_SENSITIVITY = false,
  tracesDir: TRACE_DIR = CONFIG.artifacts.traces,
  specs = /** @type {string[] | null} */ (null),
}) {
  if (!catalog.every((m) => isArtifactId(m.id) && typeof m.spec === "string"))
    throw new Error("invalid mutation identity");
  const MUTATIONS = specs
    ? catalog.filter((m) => specs.includes(m.spec))
    : catalog;
  TRACE_DIR = path.resolve(CONFIG.rootDir, TRACE_DIR);
  const MUTATION_POLICY_PATH = path.resolve(
    CONFIG.rootDir,
    CONFIG.policies.mutation,
  );
  const SCHEMA_PATH = path.resolve(CONFIG.rootDir, CONFIG.artifacts.schema);
  if (CONTROL_SENSITIVITY) {
    if (!CONFIG.controlSensitivityCatalog)
      throw new Error(
        "[PROOF_FAIL] control_contract: configure a separate controlSensitivityCatalog",
      );
    const traces = readTraceDirectory(TRACE_DIR, {
      rootDir: CONFIG.rootDir,
      excludedPaths: evidenceExclusions(CONFIG),
    });
    const ids = new Set();
    const mutations = MUTATIONS.map((m) => {
      if (ids.has(m.id)) throw new Error("duplicate control-sensitivity id");
      ids.add(m.id);
      return { ...m, resolvedControls: validateControlBaseline(m, traces) };
    });
    return {
      mutations,
      problems: [],
      claims: [],
      acceptedClaims: [],
      uncoveredClaims: [],
      uncoveredActionClaims: [],
    };
  }
  const derived = deriveAutomaticRlsMutations({
    tracesDir: TRACE_DIR,
    rootDir: CONFIG.rootDir,
    excludedPaths: evidenceExclusions(CONFIG),
    schemaPath: SCHEMA_PATH,
    explicitMutations: MUTATIONS,
  });
  const mutations = [...MUTATIONS, ...derived.mutations];
  const ids = new Set();
  const problems = [...derived.problems];

  for (const mutation of mutations) {
    if (ids.has(mutation.id)) {
      problems.push(`duplicate mutation id "${mutation.id}"`);
    }
    ids.add(mutation.id);
  }

  const loadedPolicy = readMutationPolicy(MUTATION_POLICY_PATH);
  if (specs)
    loadedPolicy.policy = {
      ...loadedPolicy.policy,
      acceptedClaims: (loadedPolicy.policy.acceptedClaims ?? []).filter((c) =>
        specs.includes(c.spec),
      ),
    };
  const claimCoverage = evaluateMutationClaimCoverage({
    claims: derived.claims,
    evidence: derived.evidence,
    mutations,
    policy: loadedPolicy.policy,
  });
  problems.push(...loadedPolicy.problems, ...claimCoverage.problems);
  for (const claim of claimCoverage.uncoveredClaims) {
    problems.push(
      `${claim.spec} has no mutation or accepted policy entry for ${claim.kind}:${claim.target}:${claim.operation}`,
    );
  }

  const mutationsWithClaims = mutations.map((mutation) => ({
    ...mutation,
    resolvedClaims: derived.claims
      .filter((claim) => mutationCoversClaim(mutation, claim))
      .map((claim) => ({
        kind: claim.kind,
        target: claim.target,
        operation: claim.operation,
      })),
  }));

  return {
    mutations: mutationsWithClaims,
    problems,
    claims: derived.claims,
    acceptedClaims: claimCoverage.acceptedClaims,
    uncoveredClaims: claimCoverage.uncoveredClaims,
    uncoveredActionClaims: claimCoverage.uncoveredClaims.filter((claim) =>
      /^[A-Za-z][\w-]*:[A-Za-z][\w-]*$/.test(claim.target),
    ),
  };
}
