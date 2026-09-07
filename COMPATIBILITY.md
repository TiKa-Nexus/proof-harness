# Compatibility

| `proof-harness` | Trace artifact schema | Mission manifest schema | Proof health protocol | Node.js |
| --- | ---: | ---: | ---: | --- |
| `0.1.x` | 2 | 1 | 1 | 24 |

## Prerelease consumers

Consumers must pin an exact prerelease version, for example:

```json
{
  "devDependencies": {
    "proof-harness": "0.1.0-next.7"
  }
}
```

Do not use `^`, `~`, `next`, or another floating range for prereleases. Until
the package reaches a stable release, a newer candidate may intentionally
tighten validation or packaging contracts even when its base version remains
`0.1.0`.

The trace, mission, and health protocol versions are independent from the npm
package version. Consumers should reject unsupported artifact or protocol
versions rather than guessing how to interpret them.

## Prerelease migration notes

<a id="unreleased-audit-hardening"></a>

### 0.1.0-next.7

Published September 7, 2026. This release tightens acceptance behavior. Trace
schema remains 2, with additive source/execution identity fields. Version 1
and unversioned trace shapes remain explicitly readable, but CLI acceptance
requires current provenance. Required consumer changes:

- Regenerate traces. `verify`, `coverage`, and mutation inventory share a
  decoder: corrupt JSON, duplicate proof IDs, unknown vocabulary, and
  contradictory verdicts fail. Only passing baseline evidence can satisfy
  claims; mutation evidence is separate. Current spec contents must match
  `specHash`; in Git worktrees both `commit` and `sourceHash` must match.
  `sourceHash` includes tracked and untracked nonignored inputs and excludes
  configured generated artifacts. Run generators before proofs. Non-Git
  exports cannot establish whole-source freshness and only check spec hashes.
- Use a dedicated trace directory. The writer honors `artifacts.traces` and
  the runner's `--traces-dir` override. IDs must use letters, digits, dots,
  underscores, or hyphens, starting with a letter or digit. Duplicate IDs
  cannot overwrite another proof; a later Playwright retry of the same test
  may replace its earlier attempt. Standalone repeated runs need fresh output.
  Mission aggregates now live at `<traces>/missions/<missionId>.json` to
  prevent collisions with proof IDs. Cleanup refuses unknown JSON before
  deleting any trace and rejects repository/ancestor directories, including
  symlink aliases. Move legacy or corrupt files aside before rerunning.
- UPDATE denial probes require stable `identityColumns` (default `["id"]`),
  present and non-null in every target row, excluded from the update payload.
  The attempted update must change a value. Rereads use original identities,
  even when a write changes a filter column. SQL errors other than `42501`
  are incomplete evidence. INSERT probes require a payload absent before the
  probe and valid for a service-role control insertion; that control is
  cleaned up. HTTP expectations must contain a status or a nonempty matcher
  list. Write requests are never automatically retried after transport errors.
- Capability discovery uses TypeScript syntax analysis for import aliases and
  multiple actions. Unknown factory/client indirection, escaped service query
  builders, dynamic table names, and ambiguous metadata block assessment.
  Discovery still assumes the configured template action layout.
- The SQL parser is deliberately conservative, not a final PostgreSQL catalog
  evaluator. Unsupported ALTER/DROP or dynamic SQL makes schema assessment
  fail. RLS must be explicitly enabled for classification; public ALL/write
  policies are never exempted as public-read. Policy expressions and mode
  participate in drift. Resolve unsupported migrations with a catalog-backed
  integration before using this parser as a gate; do not edit shipped SQL or
  mark an unassessed artifact assessed to obtain a pass.
- Drift always regenerates both trees using the installed harness and each
  tree's consumer configuration. It includes untracked actions, SQL, and
  lockfiles. For ignored/generated migrations, configure `driftPrepare` as a
  command argv array (for example `["node", "scripts/aggregate_migrations.mjs",
  "--fresh"]`). That consumer-owned command runs in each tree before parsing;
  failure prevents assessment. It must work in the archived tree without an
  implicit dependency install. The old `driftSources` optimization is unused.
- Mutations require fresh mapped baseline claims and write isolated traces.
  SQL applies run as one transaction; recovery is attempted even after a
  failed apply. Policy snapshots preserve expressions, roles, command, and
  permissive/restrictive mode. Generic privilege mutations support direct,
  owner-issued grants without grant options; unsupported inherited/PUBLIC or
  ownership cases fail before planting. Move old mutation outputs aside on
  first use: nonempty output directories require a harness ownership marker.
  An interrupted run leaves `mutation-recovery.json` beside the mutation output
  directory. Run `proof-harness mutate --recover` against the same local
  database to restore and verify the journaled subject. A timeout, signal, or
  incomplete failed claim never counts as detection. Recovery covers the
  catalog's declared subject and cleanup, not arbitrary undeclared side effects.
- Partial fixture setup is cleaned up, and cleanup errors now fail the proof.

These checks validate observed evidence. Protect the installed harness,
configuration, mission, policies, mutation catalog, and CI acceptance job from
executor edits. Trace metadata is not a signature or a sandbox: it cannot
establish honesty against an executor allowed to replace the gate or fabricate
its inputs. Independent product acceptance and a trusted runner remain needed.

### 0.1.0-next.6

**Removed: the module-descriptor system.** It served the consumer's planner
(what a module is for, what a buyer must decide, where answers land) and never
fed verification, so it is now consumer-owned. Gone from the package:

- CLI commands `modules` and `modules-check` (and the `modules` step inside
  `build`); the `.proof/module-policy.json` accept-list introduced in
  `next.5` went with the checker.
- `proof-harness/shared` exports `ModuleMeta`, `ModuleDecision`,
  `ModuleInput`, `ModuleDefault`, `ModuleSeam`, `ScannedModule`,
  `ModulesArtifact`, `MODULE_DESCRIPTOR_SCHEMA_VERSION`, `MODULE_KINDS`,
  `APPLIED_BY`, `ModuleKind`, `AppliedBy`, `isModuleKind`, `isAppliedBy`.
- The `proof.config.mjs` keys `artifacts.modules`, `policies.module`,
  `roots.modules`, `roots.sharedModules`, and `moduleKinds` (now ignored if
  supplied).

Migration: consumers using the system vendor it from
`proof-harness@0.1.0-next.5` (Apache-2.0) — `cli/engines/scan_module_meta.mjs`,
`cli/engines/proof_module_check.mjs`, and `src/shared/module-types.ts` plus the
two vocabularies above — and point their `module.meta.ts` type imports at the
vendored copy. Consumers that never ran `proof:modules` are unaffected. Trace,
mission, and health protocol versions are unchanged.

### 0.1.0-next.5

No artifact schema or protocol changes. Three behavioral changes:

- **`seed.workspace` no longer writes `type`.** The insert carries only
  `name` plus caller-supplied values — the harness never invents a column
  value it wasn't given. A schema whose `workspaces` table has required
  columns without defaults (the conventional template's `type` included)
  must supply them via `seed.workspace(name, { columns: { … } })` or the new
  `workspaceColumns` option on `assert.tenantIsolation`, or add a database
  default.
- **`createProofServiceClient` refuses non-local targets.** Any
  `NEXT_PUBLIC_SUPABASE_URL` whose parsed hostname is not
  `localhost`/`127.0.0.1`/`[::1]` aborts as `unsafe_database` before a
  client is constructed, because the suite deletes the users and workspaces
  it seeds. CI setups reaching Supabase through a docker-network hostname
  call `allowProofServiceHosts(["<host>"])` in code; there is no environment
  override.
- **`modules-check` gains an accept-list.** `.proof/module-policy.json`
  (`schemaVersion: 1`, `acceptedUndescribed: [{ module, reason }]`) lets an
  adopting consumer record undescribed required-root modules as visible debt
  instead of turning the check off. Entries that stop applying fail as
  `module_policy_stale`. Absent file = no acceptances; existing consumers
  are unaffected.

### 0.1.0-next.4

No entry-point, artifact schema, or protocol changes. The `mutate` command
tightens validation: each mutation's subject is now read back after apply and
again after its proof, so a defect that never took effect fails as
`NOT PLANTED` and one that was externally undone mid-run fails as
`UN-PLANTED` — both distinct from a missed proof. A catalog mutation whose
`apply` intentionally leaves its subject unchanged (it plants a side object
that `cleanup` removes) must now declare `applyDoesNotChangeSubject: true`;
runs with such undeclared mutations fail until the flag is added. The shared
dev server is also started before the first defect is planted rather than
inside the first mutation's window.
