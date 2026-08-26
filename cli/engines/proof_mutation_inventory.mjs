import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function specHash(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")
    .slice(0, 12);
}

function isPrimary(assertion) {
  return (
    assertion.role === undefined ||
    assertion.role === null ||
    assertion.role === "primary" ||
    assertion.role === "negative"
  );
}

function resolveTable(target, tableNames) {
  if (typeof target !== "string") return null;
  const table = target.split(".", 1)[0];
  return tableNames.has(table) ? table : null;
}

function isActionTarget(target) {
  return (
    typeof target === "string" && /^[A-Za-z][\w-]*:[A-Za-z][\w-]*$/.test(target)
  );
}

const CLAIM_OPERATIONS = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "invoke",
  "request",
]);

export function mutationClaimKey(claim) {
  return `${claim.spec}\0${claim.kind}\0${claim.target}\0${claim.operation}`;
}

function claimSelectorMatches(selector, claim) {
  return (
    selector.kind === claim.kind &&
    selector.target === claim.target &&
    (selector.operation === undefined || selector.operation === claim.operation)
  );
}

function targetTable(target) {
  if (typeof target !== "string") return null;
  if (target.startsWith("/") || isActionTarget(target)) return null;
  return target.split(".", 1)[0] || null;
}

function subjectFunctionName(signature) {
  if (typeof signature !== "string") return null;
  const withoutArgs = signature.split("(", 1)[0];
  return withoutArgs.split(".").at(-1) ?? null;
}

export function mutationCoversClaim(mutation, claim) {
  if (mutation.spec !== claim.spec) return false;

  if (Array.isArray(mutation.claims)) {
    return mutation.claims.some((selector) =>
      claimSelectorMatches(selector, claim),
    );
  }

  const subject = mutation.subject;
  if (!subject) return false;

  if (subject.kind === "functionPrivilege") {
    return subjectFunctionName(subject.signature) === claim.target;
  }

  if (typeof subject.table !== "string") return false;
  const table = subject.table.replace(/^public\./, "");
  if (targetTable(claim.target) !== table) return false;

  if (
    subject.kind === "tablePrivilege" &&
    typeof subject.privilege === "string"
  ) {
    return subject.privilege.toLowerCase() === claim.operation;
  }

  return true;
}

function explicitMutationCoversClaim(mutation, claim) {
  if (mutation.spec !== claim.spec) return false;
  if (
    mutation.subject?.kind !== "policy" &&
    mutation.subject?.kind !== "rowLevelSecurity"
  ) {
    return false;
  }
  return mutation.subject.table === `public.${claim.table}`;
}

function validObservedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && parsed <= Date.now();
}

/**
 * Join fresh primary claims to mutations and committed policy exceptions.
 * Policy entries are intentionally hash-pinned and control-backed: editing a
 * proof or deleting the positive control makes the acceptance stale.
 */
export function evaluateMutationClaimCoverage({
  claims,
  evidence,
  mutations,
  policy,
}) {
  const problems = [];
  const covered = new Set();

  for (const claim of claims) {
    if (mutations.some((mutation) => mutationCoversClaim(mutation, claim))) {
      covered.add(mutationClaimKey(claim));
    }
  }

  const accepted = new Set();
  const seenAcceptances = new Set();
  for (const entry of policy?.acceptedClaims ?? []) {
    const key = mutationClaimKey(entry);
    if (seenAcceptances.has(key)) {
      problems.push(
        `duplicate accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec}`,
      );
      continue;
    }
    seenAcceptances.add(key);

    const claim = claims.find(
      (candidate) => mutationClaimKey(candidate) === key,
    );
    if (!claim) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} is stale — no fresh passing primary assertion has that claim`,
      );
      continue;
    }
    if (covered.has(key)) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} is stale — a mutation now covers it`,
      );
      continue;
    }
    if (entry.specHash !== claim.specHash) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} is stale — expected specHash ${claim.specHash}, found ${entry.specHash ?? "<missing>"}`,
      );
      continue;
    }
    if (!validObservedAt(entry.reviewedAt)) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} needs a valid non-future reviewedAt date`,
      );
      continue;
    }
    if (
      typeof entry.expectedFailureCategory !== "string" ||
      entry.expectedFailureCategory.trim() === ""
    ) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} needs expectedFailureCategory`,
      );
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} needs a durable reason`,
      );
      continue;
    }

    const control = entry.survivingPositiveControl;
    const controlFound =
      control &&
      evidence.some(
        (item) =>
          item.spec === entry.spec &&
          item.kind === control.kind &&
          item.target === control.target &&
          (control.operation === undefined ||
            item.operation === control.operation) &&
          (item.role === "control" || item.kind === "happy_path"),
      );
    if (!controlFound) {
      problems.push(
        `accepted mutation claim ${entry.kind}:${entry.target}:${entry.operation} in ${entry.spec} has no fresh surviving positive control matching ${control?.kind ?? "<missing>"}:${control?.target ?? "<missing>"}`,
      );
      continue;
    }

    accepted.add(key);
  }

  const uncoveredClaims = claims.filter((claim) => {
    const key = mutationClaimKey(claim);
    return !covered.has(key) && !accepted.has(key);
  });

  return {
    coveredClaims: claims.filter((claim) =>
      covered.has(mutationClaimKey(claim)),
    ),
    acceptedClaims: claims.filter((claim) =>
      accepted.has(mutationClaimKey(claim)),
    ),
    uncoveredClaims,
    problems,
  };
}

function automaticMutationId(claim) {
  const specName = path.basename(claim.spec, ".proof.ts");
  return `AUTO-RLS-${specName}-${claim.table}`;
}

function traceFiles(tracesDir) {
  if (!fs.existsSync(tracesDir)) return [];
  return fs
    .readdirSync(tracesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(tracesDir, file))
    .sort();
}

/**
 * Derive broad, policy-name-independent RLS mutations from fresh green
 * evidence. Only passing primary tenant-isolation assertions for classified
 * scoped tables count. Existing narrow policy/RLS mutations remain
 * authoritative and are not duplicated.
 */
export function deriveAutomaticRlsMutations({
  tracesDir,
  schemaPath,
  explicitMutations,
  rootDir = process.cwd(),
}) {
  const problems = [];
  let schema;
  try {
    schema = readJson(schemaPath);
  } catch (error) {
    return {
      mutations: [],
      problems: [
        `cannot derive automatic RLS mutations because ${normalizePath(
          path.relative(rootDir, schemaPath),
        )} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ],
      claims: [],
      evidence: [],
      uncoveredActionClaims: [],
    };
  }

  const classifications = new Map(
    (schema.tables ?? []).map((table) => [
      table.name,
      table.rls_classification,
    ]),
  );
  const tableNames = new Set(classifications.keys());
  const tenantClaims = new Map();
  const claims = new Map();
  const evidence = new Map();

  for (const traceFile of traceFiles(tracesDir)) {
    let artifact;
    try {
      artifact = readJson(traceFile);
    } catch (error) {
      problems.push(
        `${normalizePath(path.relative(rootDir, traceFile))} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    // Aggregated mission traces and intentional red mutation traces are not
    // baseline evidence from which new mutations may be derived.
    if (
      Array.isArray(artifact.traces) ||
      artifact.mutation?.planted ||
      artifact.passed !== true
    ) {
      continue;
    }

    const scopedTables = new Set();
    const artifactClaims = new Map();
    const artifactEvidence = new Map();
    for (const step of artifact.steps ?? []) {
      const stepAssertions = step.assertions ?? [];
      const hasDecisiveAssertion = stepAssertions.some(
        (assertion) =>
          assertion.status !== "skipped" &&
          assertion.status !== "incomplete" &&
          assertion.passed === true,
      );
      if (
        step.passed === true &&
        (stepAssertions.length === 0 || hasDecisiveAssertion)
      ) {
        const stepKey = `step\0${step.kind}\0${step.target}`;
        artifactEvidence.set(stepKey, {
          kind: step.kind,
          target: step.target,
          role: "step",
          source: "step",
        });
      }
      for (const assertion of stepAssertions) {
        if (
          assertion.passed !== true ||
          assertion.status === "skipped" ||
          assertion.status === "incomplete"
        ) {
          continue;
        }

        const role = isPrimary(assertion) ? "primary" : "control";
        if (role === "control") {
          const key = `${assertion.kind}\0${assertion.target}\0${assertion.operation ?? ""}`;
          artifactEvidence.set(key, {
            kind: assertion.kind,
            target: assertion.target,
            operation: assertion.operation,
            role,
            source: "assertion",
          });
          continue;
        }

        if (!CLAIM_OPERATIONS.has(assertion.operation)) {
          problems.push(
            `${artifact.specFile ?? normalizePath(path.relative(rootDir, traceFile))} has a passing primary ${assertion.kind}:${assertion.target} assertion without a supported operation; run proof:verify again after updating the proof SDK`,
          );
          continue;
        }

        const claimKey = `${assertion.kind}\0${assertion.target}\0${assertion.operation}`;
        artifactClaims.set(claimKey, {
          kind: assertion.kind,
          target: assertion.target,
          operation: assertion.operation,
        });

        if (assertion.kind !== "tenant_isolation") continue;

        const table = resolveTable(assertion.target, tableNames);
        if (!table) continue;
        const classification = classifications.get(table);
        if (
          classification !== "workspace_scoped" &&
          classification !== "user_scoped"
        ) {
          continue;
        }
        scopedTables.add(table);
      }
    }
    if (
      scopedTables.size === 0 &&
      artifactClaims.size === 0 &&
      artifactEvidence.size === 0
    ) {
      continue;
    }

    if (typeof artifact.specFile !== "string") {
      problems.push(
        `${normalizePath(path.relative(rootDir, traceFile))} contains proof evidence but has no specFile provenance`,
      );
      continue;
    }
    const absoluteSpec = path.resolve(rootDir, artifact.specFile);
    const relativeSpec = path.relative(rootDir, absoluteSpec);
    if (
      relativeSpec.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeSpec) ||
      !relativeSpec.endsWith(".proof.ts")
    ) {
      problems.push(
        `${artifact.specFile} is not a proof spec inside the current repository`,
      );
      continue;
    }
    if (!fs.existsSync(absoluteSpec)) {
      problems.push(
        `${artifact.specFile} is referenced by proof evidence but no longer exists`,
      );
      continue;
    }
    if (typeof artifact.specHash !== "string") {
      problems.push(
        `${artifact.specFile} has proof evidence but no specHash freshness provenance; run proof:verify again`,
      );
      continue;
    }
    if (artifact.specHash !== specHash(absoluteSpec)) {
      problems.push(
        `${artifact.specFile} changed after its proof trace was written; run proof:verify again`,
      );
      continue;
    }

    const spec = normalizePath(relativeSpec);
    for (const table of scopedTables) {
      tenantClaims.set(`${spec}\0${table}`, { spec, table });
    }
    for (const claim of artifactClaims.values()) {
      claims.set(
        `${spec}\0${claim.kind}\0${claim.target}\0${claim.operation}`,
        {
          spec,
          specHash: artifact.specHash,
          proofId: artifact.proofId,
          ...claim,
        },
      );
    }
    for (const item of artifactEvidence.values()) {
      evidence.set(
        `${spec}\0${item.source}\0${item.kind}\0${item.target}\0${item.operation ?? ""}`,
        {
          spec,
          specHash: artifact.specHash,
          proofId: artifact.proofId,
          ...item,
        },
      );
    }
  }

  const automaticMutations = [];
  for (const claim of tenantClaims.values()) {
    if (
      explicitMutations.some((mutation) =>
        explicitMutationCoversClaim(mutation, claim),
      )
    ) {
      continue;
    }
    automaticMutations.push({
      id: automaticMutationId(claim),
      finding: "automatic tenant isolation",
      breaks: `disables row-level security on public.${claim.table}, exposing rows regardless of policy names`,
      spec: claim.spec,
      apply: `ALTER TABLE public.${claim.table} DISABLE ROW LEVEL SECURITY;`,
      subject: {
        kind: "rowLevelSecurity",
        table: `public.${claim.table}`,
      },
      claims: [
        {
          kind: "tenant_isolation",
          target: claim.table,
          operation: "select",
        },
      ],
      expectFailureContains: "tenant_isolation",
      automatic: true,
    });
  }

  const uncoveredActionClaims = [...claims.values()].filter(
    (claim) =>
      isActionTarget(claim.target) &&
      !explicitMutations.some((mutation) =>
        mutationCoversClaim(mutation, claim),
      ),
  );

  return {
    mutations: automaticMutations,
    problems,
    claims: [...claims.values()],
    evidence: [...evidence.values()],
    uncoveredActionClaims,
  };
}
