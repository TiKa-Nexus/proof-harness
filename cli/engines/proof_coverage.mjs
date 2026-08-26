#!/usr/bin/env node
// ---------------------------------------------------------------------------
// proof_coverage.mjs
//
// What is protected, and what do we merely believe?
//
// Every other check in this system is scoped to one mission: the manifest says
// what this PR must prove, and the validator grades the PR against its own
// homework. That leaves a blind spot with a specific shape — a mission adds a
// new scoped table, never asks for tenant isolation on it, CI goes green, and
// nothing in the pipeline is capable of noticing that a new route can leak
// across tenants.
//
// This script closes that by grading the whole schema instead of one mission.
// It joins three artifacts that are regenerated on every run:
//
//   .proof/schema.json        every table + its RLS classification
//   .proof/capabilities.json  every action + the invariants it declares
//   .proof/traces/*.json      every assertion a proof actually emitted
//
// and reports, per table, whether a proof exists for the invariant its
// classification implies — plus, per action, whether every invariant it declares
// via `withProof` is backed by an assertion. It also derives a mandatory
// action-layer requirement when a workspace-id-driven action mutates data
// through the service role: both a refusal and a working
// allowed-path control must be present, regardless of `withProof` metadata.
//
// IMPORTANT — what a gap does and does not mean:
//   "No proof" is NOT "unprotected". These tables have RLS policies; the
//   classification in schema.json was derived FROM those policies. A gap means
//   the policy is asserted by a migration and never exercised by a test. The
//   honest word is *unproven*, not unprotected.
//
// The verdict is computed evidence measured against authored intent:
//   - evidence comes from the traces, and is never committed;
//   - intent lives in .proof/coverage-policy.json, which IS committed, because
//     an accepted gap is a decision a human made, not a fact about a run.
//
// With --strict, an unaccepted gap fails the build. That makes the policy file
// a ratchet: today's gaps are listed and pass, but the next scoped table added
// without a proof fails CI until someone either proves it or writes down, in a
// reviewable diff, why they chose not to.
//
// Usage:
//   node scripts/proof_coverage.mjs            # report
//   node scripts/proof_coverage.mjs --strict   # exit 1 on any unaccepted gap
//   node scripts/proof_coverage.mjs --json     # machine-readable report
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the helper-identity lists, shared with the
// mission validators; see portable-vocabulary.mjs for the rationale.
import {
  TENANT_ISOLATION_ACTION_HELPERS,
  TENANT_ISOLATION_TABLE_HELPERS,
} from "../../dist/portable-vocabulary.js";
import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const SCHEMA_PATH = CONFIG.artifacts.schema;
const CAPABILITIES_PATH = CONFIG.artifacts.capabilities;
const TRACES_DIR = CONFIG.artifacts.traces;
const POLICY_PATH = CONFIG.policies.coverage;

/**
 * The invariant each classification implies, and why.
 *
 * Read as: "if the parser concluded a table is reachable this way, then this is
 * the claim a proof has to make about it."
 */
const REQUIRED_BY_CLASSIFICATION = {
  workspace_scoped: {
    kind: "tenant_isolation",
    because:
      "reachable by members of a workspace, so another workspace must not read it",
  },
  user_scoped: {
    kind: "tenant_isolation",
    because: "reachable by its owning user, so another user must not read it",
  },
  admin_only: {
    kind: "authorization",
    because:
      "no authenticated policy grants access, so a normal user must be refused",
  },
  service_only: {
    kind: "authorization",
    because:
      "only the service role may touch it, so an authenticated client must be refused",
  },
  // Deliberately absent: `public_read` (readable by design) and `unclassified`
  // (the parser could not determine reachability — reported separately, since a
  // table we cannot classify is a blind spot rather than a gap).
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readJson(file, { required = true } = {}) {
  if (!fs.existsSync(file)) {
    if (!required) return null;
    console.error(
      `[proof:coverage] ${file} not found.\n` +
        `  suggestion: run \`pnpm proof:build\` (and \`pnpm proof:verify\` for traces).`,
    );
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[proof:coverage] ${file} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}

/** Every assertion from every trace, flattened. Steps may nest assertions. */
function readAssertions() {
  if (!fs.existsSync(TRACES_DIR)) return [];
  const out = [];
  for (const file of fs.readdirSync(TRACES_DIR)) {
    if (!file.endsWith(".json")) continue;
    const parsed = readJson(path.join(TRACES_DIR, file));
    for (const artifact of Array.isArray(parsed) ? parsed : [parsed]) {
      // The aggregate <missionId>.json embeds every per-spec trace; skip it so
      // assertions are not counted twice.
      if (Array.isArray(artifact?.traces)) continue;
      const nested = (artifact?.steps ?? []).flatMap((s) => s.assertions ?? []);
      for (const assertion of [...(artifact?.assertions ?? []), ...nested]) {
        out.push({ ...assertion, proofId: artifact?.proofId ?? null });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Target resolution
//
// Assertion targets are free-form by design, and in practice they take several
// shapes: `workspace_members`, `workspace_members.insert`,
// `users.is_super_admin`, `/secret-admin`, `deduct_workspace_credits`,
// `workspace:removeMember`.
//
// Rather than impose a naming convention on every proof (and break targets that
// missions already reference), resolution is decided by the schema itself: the
// segment before the first `.` is a table only if schema.json says such a table
// exists. That makes the join unambiguous without a convention, and it fails in
// the safe direction — a typo resolves to nothing, so the table it was meant to
// cover still shows up as a gap rather than being silently marked proven.
//
// Anything that does not resolve is reported, so the join is never silent.
// ---------------------------------------------------------------------------

function resolveTable(target, tableNames) {
  const head = String(target).split(".")[0];
  return tableNames.has(head) ? head : null;
}

function normalizedRole(assertion) {
  if (assertion.role === "control" || assertion.role === "positive_control") {
    return "control";
  }
  return "primary";
}

/**
 * Whether an assertion's origin is trustworthy enough to count as coverage
 * evidence for its kind.
 *
 * `tenant_isolation` claims must carry helper provenance (`emittedBy`), and
 * the stamp is identity-checked, not merely present-checked:
 * `assert.httpResponse` records whatever `kind` its caller passes, so its
 * stamp on an isolation assertion would prove only that an HTTP probe ran.
 * Isolation OF A TABLE is exactly what `assert.tenantIsolation` proves, so
 * table targets accept only it; action-ref targets also accept
 * `assert.authorization`, whose action probes record the cross-tenant
 * invariant they establish. Other kinds accept spec-recorded assertions —
 * bespoke probes (RPC grants, column guards) are legitimate there and remain
 * backstopped by the mutation inventory.
 */
function verifiedOrigin(assertion, { isTable }) {
  if (assertion.kind !== "tenant_isolation") return true;
  const allowed = isTable
    ? TENANT_ISOLATION_TABLE_HELPERS
    : TENANT_ISOLATION_ACTION_HELPERS;
  return allowed.includes(assertion.emittedBy);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport() {
  const schema = readJson(SCHEMA_PATH);
  const capabilities = readJson(CAPABILITIES_PATH);
  const policy = readJson(POLICY_PATH, { required: false }) ?? {
    acceptedGaps: [],
  };
  const assertions = readAssertions();

  const tableNames = new Set((schema.tables ?? []).map((t) => t.name));

  // table -> Set(kind) of PASSING PRIMARY assertions. Controls and non-passing
  // assertions are excluded on purpose: a control proves the fixture works, not
  // the claim, and only a primary assertion is evidence of the invariant.
  const provenKinds = new Map();
  const unresolved = new Map();
  // Passing primaries whose origin disqualifies them (see verifiedOrigin).
  // Reported rather than dropped, so the gap they leave behind is explicable.
  const unverifiedOrigin = [];

  for (const a of assertions) {
    if (normalizedRole(a) !== "primary") continue;
    if (a.passed !== true) continue;
    const resolved = resolveTable(a.target, tableNames);
    if (!verifiedOrigin(a, { isTable: resolved !== null })) {
      unverifiedOrigin.push({
        kind: a.kind,
        target: a.target,
        emittedBy: a.emittedBy ?? null,
        proofId: a.proofId ?? null,
      });
      continue;
    }
    const table = resolved;
    if (!table) {
      const key = `${a.kind}:${a.target}`;
      unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
      continue;
    }
    if (!provenKinds.has(table)) provenKinds.set(table, new Set());
    provenKinds.get(table).add(a.kind);
  }

  const accepted = new Map(
    (policy.acceptedGaps ?? []).map((g) => [`${g.table}:${g.kind}`, g]),
  );
  const usedAcceptances = new Set();
  const acceptedActionGaps = new Map(
    (policy.acceptedActionGaps ?? []).map((gap) => [gap.action, gap]),
  );
  const usedActionAcceptances = new Set();

  const reviewed = new Map(
    (policy.reviewedUnclassified ?? []).map((r) => [r.table, r]),
  );
  const usedReviews = new Set();

  const rows = [];
  const unassessable = [];

  for (const table of [...(schema.tables ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const requirement = REQUIRED_BY_CLASSIFICATION[table.rls_classification];
    if (!requirement) {
      // A table the parser cannot classify is the one case where no requirement
      // can be derived, which means it can never be reported as a gap. Left at
      // that, an unparseable policy would be the cheapest way to disappear from
      // this report entirely — so each one has to be acknowledged by hand.
      if (table.rls_classification === "unclassified") {
        const review = reviewed.get(table.name);
        if (review) usedReviews.add(table.name);
        unassessable.push({
          table: table.name,
          note: review?.note ?? null,
          acknowledged: Boolean(review),
          proof: [...(provenKinds.get(table.name) ?? [])].sort(),
        });
      }
      continue;
    }

    const proven = provenKinds.get(table.name)?.has(requirement.kind) ?? false;
    const acceptance = accepted.get(`${table.name}:${requirement.kind}`);
    if (!proven && acceptance)
      usedAcceptances.add(`${table.name}:${requirement.kind}`);

    rows.push({
      table: table.name,
      classification: table.rls_classification,
      requires: requirement.kind,
      because: requirement.because,
      status: proven ? "proven" : acceptance ? "accepted_gap" : "gap",
      acceptedReason: acceptance?.reason ?? null,
      otherProof: [...(provenKinds.get(table.name) ?? [])].sort(),
    });
  }

  // An acceptance for a table that is now proven, or that no longer exists, is
  // stale. Left unreported it would quietly license a future regression.
  const staleAcceptances = (policy.acceptedGaps ?? [])
    .filter((g) => !usedAcceptances.has(`${g.table}:${g.kind}`))
    .map((g) => ({
      ...g,
      why: tableNames.has(g.table)
        ? "the invariant is now proven — delete the acceptance"
        : "no such table in schema.json — delete or fix the acceptance",
    }));

  const staleReviews = (policy.reviewedUnclassified ?? [])
    .filter((r) => !usedReviews.has(r.table))
    .map((r) => ({
      ...r,
      why: tableNames.has(r.table)
        ? "the table is now classified, so a real requirement applies — delete the acknowledgement"
        : "no such table in schema.json — delete or fix the acknowledgement",
    }));

  const declaredInvariants = (capabilities.capabilities ?? []).filter(
    (c) => (c.invariants ?? []).length > 0,
  );

  // Action-level claims.
  //
  // `withProof` is voluntary, so it cannot be used to derive what an action
  // OUGHT to prove — omitting it stays free. What it can do is make a
  // declaration cost something: an action that claims an invariant must have a
  // passing primary assertion against `<module>:<name>`, the same ref the
  // scanner writes into capabilities.json.
  //
  // Deliberately no acceptance path here, unlike table gaps. A table's
  // requirement is derived from its policies, so it exists whether anyone likes
  // it or not and sometimes has to be waived. A declared claim is authored, so
  // the honest escape hatch is deleting the claim rather than excusing it.
  const actionRows = [];
  for (const capability of [...declaredInvariants].sort((a, b) =>
    `${a.module}:${a.name}`.localeCompare(`${b.module}:${b.name}`),
  )) {
    const ref = `${capability.module}:${capability.name}`;
    for (const kind of capability.invariants ?? []) {
      const key = `${kind}:${ref}`;
      const proven = unresolved.has(key);
      // Matched refs are removed so they stop being reported as targets that
      // resolved to nothing — they resolved to an action.
      if (proven) unresolved.delete(key);
      actionRows.push({
        action: ref,
        requires: kind,
        status: proven ? "proven" : "gap",
        file: capability.file ?? null,
      });
    }
  }

  // Mandatory service-role action boundaries.
  //
  // This requirement is derived from code + schema, not optional withProof
  // metadata. The scanner reports concrete service-role mutations and whether
  // the user-facing action takes a workspaceId. The workspaceId is the scope
  // signal here: tenant-root tables such as `workspaces` are classified as
  // user_scoped by their owner policy, but a service-role action accepting an
  // arbitrary workspaceId still needs an action-layer cross-tenant probe.
  //
  // A denial alone is not enough. A broken/unregistered action also refuses
  // everyone, so the same action target needs a passing allowed-path control.
  const denialKinds = new Set(["authorization", "tenant_isolation"]);
  const controlKinds = new Set([
    "authorization",
    "tenant_isolation",
    "happy_path",
  ]);
  const serviceRoleActionRows = [];

  for (const capability of [...(capabilities.capabilities ?? [])].sort((a, b) =>
    `${a.module}:${a.name}`.localeCompare(`${b.module}:${b.name}`),
  )) {
    if (
      capability.acceptsWorkspaceId !== true ||
      capability.internalOnly === true
    ) {
      continue;
    }

    const workspaceMutations = capability.serviceRoleMutations ?? [];
    if (workspaceMutations.length === 0) continue;

    const action = `${capability.module}:${capability.name}`;
    const denialEvidence = assertions.filter(
      (assertion) =>
        assertion.passed === true &&
        assertion.target === action &&
        normalizedRole(assertion) === "primary" &&
        denialKinds.has(assertion.kind) &&
        verifiedOrigin(assertion, { isTable: false }),
    );
    const controlEvidence = assertions.filter(
      (assertion) =>
        assertion.passed === true &&
        assertion.target === action &&
        normalizedRole(assertion) === "control" &&
        controlKinds.has(assertion.kind),
    );
    const denialProven = denialEvidence.length > 0;
    const controlProven = controlEvidence.length > 0;
    const proven = denialProven && controlProven;
    const acceptance = acceptedActionGaps.get(action);
    if (!proven && acceptance) usedActionAcceptances.add(action);

    // These targets are now resolved by a derived action requirement.
    for (const kind of denialKinds) unresolved.delete(`${kind}:${action}`);

    serviceRoleActionRows.push({
      action,
      tables: [...new Set(workspaceMutations.map((m) => m.table))].sort(),
      mutations: workspaceMutations,
      denial: denialProven ? "proven" : "gap",
      control: controlProven ? "proven" : "gap",
      status: proven ? "proven" : acceptance ? "accepted_gap" : "gap",
      acceptedReason: acceptance?.reason ?? null,
      denialProofs: [
        ...new Set(denialEvidence.map((a) => a.proofId).filter(Boolean)),
      ].sort(),
      controlProofs: [
        ...new Set(controlEvidence.map((a) => a.proofId).filter(Boolean)),
      ].sort(),
      file: capability.file ?? null,
    });
  }

  const staleActionAcceptances = (policy.acceptedActionGaps ?? [])
    .filter((gap) => !usedActionAcceptances.has(gap.action))
    .map((gap) => ({
      ...gap,
      why: serviceRoleActionRows.some((row) => row.action === gap.action)
        ? "the action boundary is now proven — delete the acceptance"
        : "no derived service-role action requirement has this ref — delete or fix the acceptance",
    }));

  return {
    rows,
    actionRows,
    serviceRoleActionRows,
    unassessable,
    unverifiedOrigin,
    staleReviews,
    unresolved: [...unresolved.entries()].map(([key, count]) => ({
      key,
      count,
    })),
    staleAcceptances,
    staleActionAcceptances,
    capabilityCount: (capabilities.capabilities ?? []).length,
    declaredInvariants,
    assertionCount: assertions.length,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// The report is read by a human deciding whether to trust a build, so it is laid
// out in sections that can be skipped: a heading says what the section grades, a
// table carries the verdicts, and prose is wrapped and indented under the row it
// belongs to instead of running off the right edge.
//
// `[PROOF_FAIL]` lines are the exception. Those are the machine-readable part of
// the contract, so each stays on one line with any guidance on an indented
// `suggestion:` line, matching the format the rest of the SDK emits.

const WIDTH = 76;

function pad(value, width) {
  return String(value).padEnd(width);
}

/** Greedy word wrap. Long unbreakable tokens (paths, refs) are left intact. */
function wrap(text, indent = "") {
  const width = Math.max(WIDTH - indent.length, 24);
  const lines = [];
  let current = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line) => `${indent}${line}`);
}

function heading(title, subtitle) {
  console.log(`\n${title}`);
  console.log("─".repeat(WIDTH));
  if (subtitle) for (const line of wrap(subtitle)) console.log(line);
}

/** columns: [{ header, get }] — widths are derived from the widest cell. */
function printTable(columns, rows) {
  const widths = columns.map((column) =>
    Math.max(
      column.header.length,
      ...rows.map((row) => String(column.get(row)).length),
    ),
  );
  const line = (cells) =>
    console.log(
      `  ${cells.map((cell, i) => pad(cell, widths[i])).join("  ")}`.trimEnd(),
    );
  line(columns.map((c) => c.header));
  line(widths.map((w) => "-".repeat(w)));
  for (const row of rows) line(columns.map((c) => String(c.get(row))));
}

function printReport(report) {
  const { rows } = report;
  const proven = rows.filter((r) => r.status === "proven");
  const acceptedGaps = rows.filter((r) => r.status === "accepted_gap");
  const gaps = rows.filter((r) => r.status === "gap");

  if (report.assertionCount === 0) {
    console.log(
      "[proof:coverage] no assertions found in .proof/traces — every table will read as a gap.\n" +
        "  suggestion: run `pnpm proof:verify` first so there is evidence to measure.",
    );
  }

  heading(
    "TABLE INVARIANTS",
    "One requirement per table, derived from its RLS classification. A gap means unproven, not unprotected.",
  );
  console.log("");
  printTable(
    [
      { header: "table", get: (r) => r.table },
      { header: "classification", get: (r) => r.classification },
      { header: "requires", get: (r) => r.requires },
      { header: "status", get: (r) => r.status },
    ],
    rows,
  );
  console.log(
    `\n  ${proven.length} proven · ${acceptedGaps.length} accepted gap(s) · ${gaps.length} unaccepted gap(s)`,
  );

  if (gaps.length > 0) {
    console.log("");
    for (const r of gaps) {
      console.log(`  ${r.table} needs ${r.requires}`);
      for (const line of wrap(r.because, "      ")) console.log(line);
    }
  }

  if (acceptedGaps.length > 0) {
    console.log(`\n  Accepted in ${POLICY_PATH}:`);
    for (const r of acceptedGaps) {
      console.log(`  ${r.table} · ${r.requires}`);
      for (const line of wrap(
        r.acceptedReason ?? "no reason given",
        "      ",
      )) {
        console.log(line);
      }
    }
  }

  if (report.actionRows.length > 0) {
    const provenActions = report.actionRows.filter(
      (r) => r.status === "proven",
    );
    heading(
      "ACTION CLAIMS",
      `Invariants declared via withProof, which must be backed by an assertion. ` +
        `${report.declaredInvariants.length} of ${report.capabilityCount} capabilities declare one; ` +
        `${provenActions.length} of ${report.actionRows.length} claim(s) proven.`,
    );
    console.log("");
    printTable(
      [
        { header: "action", get: (r) => r.action },
        { header: "requires", get: (r) => r.requires },
        { header: "status", get: (r) => r.status },
      ],
      report.actionRows,
    );
  } else if (report.capabilityCount > 0) {
    heading(
      "ACTION CLAIMS",
      `None: 0 of ${report.capabilityCount} capabilities declare an invariant via withProof, ` +
        `so there is no action-level claim to check.`,
    );
  }

  if (report.serviceRoleActionRows.length > 0) {
    const provenBoundaries = report.serviceRoleActionRows.filter(
      (r) => r.status === "proven",
    );
    const acceptedBoundaries = report.serviceRoleActionRows.filter(
      (r) => r.status === "accepted_gap",
    );
    heading(
      "SERVICE-ROLE ACTION BOUNDARIES",
      "Derived from caller-controlled workspaceId inputs plus service-role mutations. Each action needs both an unauthorized/cross-tenant refusal and an allowed-path control; withProof metadata is not consulted.",
    );
    console.log("");
    printTable(
      [
        { header: "action", get: (r) => r.action },
        { header: "tables", get: (r) => r.tables.join(",") },
        { header: "denial", get: (r) => r.denial },
        { header: "control", get: (r) => r.control },
        { header: "status", get: (r) => r.status },
      ],
      report.serviceRoleActionRows,
    );
    console.log(
      `\n  ${provenBoundaries.length} proven · ${acceptedBoundaries.length} accepted gap(s) · ` +
        `${report.serviceRoleActionRows.length - provenBoundaries.length - acceptedBoundaries.length} unaccepted gap(s)`,
    );
    if (acceptedBoundaries.length > 0) {
      console.log(`\n  Accepted in ${POLICY_PATH}:`);
      for (const row of acceptedBoundaries) {
        console.log(`  ${row.action}`);
        for (const line of wrap(
          row.acceptedReason ?? "no reason given",
          "      ",
        )) {
          console.log(line);
        }
      }
    }
  }

  if (report.unassessable.length > 0) {
    const unacknowledged = report.unassessable.filter((u) => !u.acknowledged);
    heading(
      "NOT ASSESSABLE",
      `${report.unassessable.length} table(s) whose policies the parser could not classify, so no ` +
        `requirement is derived. Each needs an entry in ${POLICY_PATH} — otherwise an unparseable ` +
        `policy is the cheapest way off this report.`,
    );
    console.log("");
    for (const u of report.unassessable) {
      const evidence =
        u.proof.length > 0
          ? `${u.proof.join(", ")} proven`
          : "no primary proof";
      console.log(
        `  ${u.table} · ${u.acknowledged ? "reviewed" : "NOT ACKNOWLEDGED"} · ${evidence}`,
      );
      const note =
        u.note ??
        "Add a reviewedUnclassified entry stating what the table is and how it is protected.";
      for (const line of wrap(note, "      ")) console.log(line);
    }
    if (unacknowledged.length > 0) {
      console.log(`\n  ${unacknowledged.length} unacknowledged`);
    }
  }

  const staleEntries = [
    ...report.staleAcceptances.map((s) => ({
      label: `accepted gap ${s.table}:${s.kind}`,
      why: s.why,
    })),
    ...report.staleReviews.map((s) => ({
      label: `acknowledgement ${s.table}`,
      why: s.why,
    })),
    ...report.staleActionAcceptances.map((s) => ({
      label: `accepted action gap ${s.action}`,
      why: s.why,
    })),
  ];
  if (staleEntries.length > 0) {
    heading(
      "STALE POLICY ENTRIES",
      `${staleEntries.length} entr(y/ies) in ${POLICY_PATH} that no longer apply. Left in place they ` +
        `license a regression nobody decided to allow.`,
    );
    console.log("");
    for (const stale of staleEntries) {
      console.log(`  ${stale.label}`);
      for (const line of wrap(stale.why, "      ")) console.log(line);
    }
  }

  if (report.unverifiedOrigin.length > 0) {
    heading(
      "UNVERIFIED ORIGIN",
      `${report.unverifiedOrigin.length} passing primary assertion(s) whose origin cannot vouch for the ` +
        `claimed kind — recorded directly by spec code, or stamped by a helper that takes its kind from the ` +
        `caller. They do NOT count as coverage evidence — emit the claim through the owning helper ` +
        `(assert.tenantIsolation for table isolation) instead.`,
    );
    console.log("");
    printTable(
      [
        { header: "kind", get: (u) => u.kind },
        { header: "target", get: (u) => u.target },
        { header: "origin", get: (u) => u.emittedBy ?? "(spec-recorded)" },
        { header: "proof", get: (u) => u.proofId ?? "(unknown)" },
      ],
      report.unverifiedOrigin,
    );
  }

  if (report.unresolved.length > 0) {
    heading(
      "UNRESOLVED TARGETS",
      `${report.unresolved.length} assertion target(s) that are neither a table nor a declared claim. ` +
        `Routes and RPCs belong here; a typo would too, which is why they are listed.`,
    );
    console.log("");
    printTable(
      [
        { header: "target", get: (u) => u.key },
        { header: "assertions", get: (u) => u.count },
      ],
      report.unresolved,
    );
  }
}

export function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const asJson = args.includes("--json");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node scripts/proof_coverage.mjs [--strict] [--json]

Reports which table-level invariants are proven by the trace evidence, which are
accepted gaps, and which are neither, plus whether every invariant an action
declares via withProof is backed by an assertion. Workspace-id-driven actions
that mutate through the service role additionally need
both a refusal and an allowed-path control. --strict exits 1 on an unaccepted
gap or an unproven action requirement.`);
    return;
  }

  const unknown = args.filter((a) => !["--strict", "--json"].includes(a));
  if (unknown.length > 0) {
    console.error(`[proof:coverage] unknown flag: ${unknown.join(", ")}`);
    process.exit(2);
  }

  const report = buildReport();

  const gaps = report.rows.filter((r) => r.status === "gap");
  const problems = [];
  if (gaps.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] coverage_gap: ${gaps.length} table(s) require an invariant that no proof asserts: ` +
        gaps.map((g) => `${g.table} (${g.requires})`).join(", "),
      suggestion: `add a proof, or record the gap in ${POLICY_PATH} with a reason`,
    });
  }
  const actionGaps = report.actionRows.filter((r) => r.status === "gap");
  if (actionGaps.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] coverage_gap: ${actionGaps.length} action(s) declare an invariant via withProof that no proof asserts: ` +
        actionGaps.map((g) => `${g.action} (${g.requires})`).join(", "),
      suggestion:
        `add a proof whose assertion kind is the invariant and whose target is the "<module>:<action>" ref, ` +
        `or drop the declaration — a claim with no evidence is worse than no claim`,
    });
  }
  const serviceRoleActionGaps = report.serviceRoleActionRows.filter(
    (r) => r.status === "gap",
  );
  if (serviceRoleActionGaps.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] service_role_action_gap: ${serviceRoleActionGaps.length} workspace-targeted service-role action(s) lack mandatory action evidence: ` +
        serviceRoleActionGaps
          .map((g) => {
            const missing = [
              g.denial === "gap" ? "denial" : null,
              g.control === "gap" ? "allowed control" : null,
            ].filter(Boolean);
            return `${g.action} (${missing.join(" + ")})`;
          })
          .join(", "),
      suggestion:
        `add a passing primary authorization/tenant_isolation assertion for the unauthorized or cross-tenant call and ` +
        `a passing control assertion for an allowed call, both targeting the exact "<module>:<action>" ref; ` +
        `if the action cannot be exercised yet, record the debt in ${POLICY_PATH}.acceptedActionGaps with a durable reason`,
    });
  }
  if (report.staleAcceptances.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] coverage_policy_stale: ${report.staleAcceptances.length} accepted gap(s) no longer apply: ` +
        report.staleAcceptances.map((s) => `${s.table}:${s.kind}`).join(", "),
      suggestion: `remove them from ${POLICY_PATH} so the policy keeps meaning what it says`,
    });
  }
  const unacknowledged = report.unassessable.filter((u) => !u.acknowledged);
  if (unacknowledged.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] coverage_blind_spot: ${unacknowledged.length} table(s) have policies the parser cannot classify and have not been reviewed: ` +
        unacknowledged.map((u) => u.table).join(", "),
      suggestion:
        `no requirement can be derived for them, so add a reviewedUnclassified entry in ${POLICY_PATH} ` +
        `stating what the table is and how it is protected`,
    });
  }
  if (report.staleReviews.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] coverage_policy_stale: ${report.staleReviews.length} acknowledgement(s) no longer apply: ` +
        report.staleReviews.map((s) => s.table).join(", "),
      suggestion: `remove them from ${POLICY_PATH}`,
    });
  }
  if (report.staleActionAcceptances.length > 0) {
    problems.push({
      line:
        `[PROOF_FAIL] coverage_policy_stale: ${report.staleActionAcceptances.length} accepted action gap(s) no longer apply: ` +
        report.staleActionAcceptances.map((gap) => gap.action).join(", "),
      suggestion: `remove them from ${POLICY_PATH} so new regressions cannot inherit obsolete exceptions`,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    if (problems.length > 0 && strict) process.exit(1);
    return;
  }

  printReport(report);

  if (problems.length === 0) {
    console.log(
      `\n[proof:coverage] PASS · ${report.rows.length - gaps.length} table invariant(s) and ` +
        `${report.actionRows.length - actionGaps.length} declared claim(s), ` +
        `${report.serviceRoleActionRows.length - serviceRoleActionGaps.length} service-role action boundary(ies) proven or accepted`,
    );
    return;
  }

  // Not strict: the sections above already show what is wrong, so summarise
  // rather than emitting a failure line, which the consumer reads as a failed
  // run. That is also why the summary below avoids the literal token — anything
  // grepping this output should find it only when the build actually failed.
  if (!strict) {
    console.log(
      `\n[proof:coverage] ${problems.length} problem(s) — re-run with --strict to fail the build on them`,
    );
    return;
  }

  console.error("");
  for (const problem of problems) {
    console.error(problem.line);
    const [first, ...rest] = wrap(problem.suggestion, "    ");
    console.error(`  suggestion: ${first.trim()}`);
    for (const line of rest) console.error(line);
    console.error("");
  }
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
