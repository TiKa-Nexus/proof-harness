# Compatibility

| `proof-harness` | Trace artifact schema | Mission manifest schema | Proof health protocol | Node.js |
| --- | ---: | ---: | ---: | --- |
| `0.1.x` | 2 | 1 | 1 | 24 |

## Prerelease consumers

Consumers must pin an exact prerelease version, for example:

```json
{
  "devDependencies": {
    "proof-harness": "0.1.0-next.6"
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

### Unreleased: direct RLS clients and Auth administration (#18)

The scanner recognizes immutable local bindings returned by
`createSupabaseRLSClient`, including named-import aliases and awaited calls.
Their table writes are assessed as RLS writes, never recorded as service-role
writes. Binding identity is local to its scope: shadowed identifiers,
reassignment, escaped clients/builders, and unresolved privilege still fail.
This remains convention-based discovery of the named consumer factories, not
verification of their implementation or arbitrary wrapper/dataflow analysis.

Direct `serviceClient.auth.admin.deleteUser(...)` is recorded in the additive
capability field `serviceRoleAuthOperations: ["deleteUser"]`, separate from
`serviceRoleMutations`. This does not pretend the Auth API is a SQL DELETE
(and does not infer whether its optional soft-delete argument is true).
Other administrative methods, dynamic method names, detached calls, and
unresolved administrative privilege remain unassessed.

Regenerate capabilities. Changes to Auth operations participate in drift under
`service_role_mutations_changed`. Coverage requires a package-origin denial
assertion and an allowed-path control for a user-facing Auth-admin action,
even when it has no workspace input or voluntary invariant declaration.
Existing explicit action-gap policy handling remains unchanged; a recognized
operation alone is not passing authorization evidence. Trace, mission and
health protocol versions are unchanged; capability schema remains additive v1.

### Unreleased: catalog providers and rollback INSERT controls (#19, #20)

These changes are not in the published `0.1.0-next.7`. They are opt-in; the
default SQL parser and REST INSERT/DELETE control remain available. No trace,
mission, or health protocol version changes. Pin the exact next candidate only
after it is released.

#### Catalog assessment

Set `schemaProvider: "scripts/proof/catalog-provider.mjs"` in the protected
`proof.config.mjs`. `parse`, the parse step of `build`, and both sides of
`drift` use it instead of the conservative SQL parser. ALTER and DROP are then
evaluated by PostgreSQL, not inferred from historical CREATE statements.

The module must export a default async function receiving:

- `protocolVersion: 1`, `rootDir` for the tree being assessed;
- `migrations`: ordered `{ path, sql, sha256 }` entries from the configured
  migration directory (top-level `.sql` files), and their combined `inputHash`;
- `withLocalPostgres(connectionUrl, callback)` and
  `readPostgresCatalog(client, schemas = ["public"])` from `proof-harness/node`.
  These are injected so the archived base needs no installed dependencies to
  import these helpers. Keep the provider's own imports dependency-free.

The consumer provider must create an empty disposable database, apply its
versioned platform bootstrap and every supplied migration in order, read the
catalog, and drop the database in `finally`. Fail on migration or cleanup
errors. Return `{ protocolVersion: 1, assessed: true, issues: [], tables }` only
after successful evaluation and cleanup; `tables` is the helper's result.
The connection helper restricts connections to loopback hosts. The consumer
owns the local database URL, creation privileges, platform bootstrap, migration
ordering, schema selection, and any required role setup. Never use the live
head database as the base catalog, clone an application-populated database,
or catch a failed migration and return partial facts.

Catalog table facts contain `schema`, `name`, `columns` (names), `rls_enabled`,
`rls_forced`, and `policies`. Each policy contains `name`, `command`, `roles`,
`mode`, `using`, and `check`. Classification is package-owned. Drift compares
column names, RLS state including FORCE, and full policy facts; this does not
add drift coverage for column types, defaults, functions, triggers, or grants.
Malformed envelopes/facts and changed migration inputs fail assessment and
replace stale successful output with an unassessed artifact.

The schema artifact adds `assessment` with provider protocol/path/hash,
migration paths/hashes, combined input hash, and repository source hash. This
is source identity, not a signature. The provider, its platform bootstrap,
configuration, and installed harness remain protected trust inputs.

For generated migrations, retain `driftPrepare` to rebuild them in each tree.
**Adoption requires a preparatory base commit:** register the provider, its
platform bootstrap, and config in the consumer before the comparison that
upgrades the package. Both base and head must declare a provider. Drift rejects
switching assessment modes across the comparison and never substitutes head
configuration for a base without the provider. Existing next.7 ignores the new
keys; registering them does not repair its conservative parser. A consumer
already blocked on next.7 needs to land this trusted setup separately before
the candidate's first successful drift run.

#### Append-only INSERT controls

Configure the protected consumer config explicitly, using your local ports:

```js
insertControl: {
  mode: "rollback",
  databaseUrlEnv: "PROOF_DATABASE_URL",
  role: "service_role",
  supabaseUrl: "http://127.0.0.1:54321",
}
```

Supply the corresponding local PostgreSQL URL through that environment
variable; never commit its password. The configured REST origin must match
`NEXT_PUBLIC_SUPABASE_URL`. The database URL must refer to the same stack,
schema, and migrations as REST; the harness validates the configured origin
but cannot discover which database a REST server actually serves.

The denied INSERT still executes through the authenticated Supabase client.
Only after an explicit `42501` denial and a service read confirming no write
does the harness validate the same payload on one PostgreSQL connection:
BEGIN, SET LOCAL ROLE, INSERT, force deferred constraints, ROLLBACK. The role
must have the intended INSERT permission. Missing columns keep their database
defaults; the harness supplies no tenancy values. An invalid payload, failed
role change, database error, or unacknowledged rollback fails as incomplete
evidence. The harness records the control assertion only after success and a
REST reread confirming no matching row remains. There is no consumer callback
that can stamp a passing control.

No DELETE privilege is needed for this control. Transactional trigger writes
also roll back, but sequence advancement and external side effects do not;
use only a disposable local stack. This control checks database validity under
the configured role, not REST middleware or an authenticated user's JWT
context. Templates whose privileged insert depends on that context must supply
a suitable database design/control strategy rather than treat this mode as
equivalent. Product authorization errors must still use SQLSTATE `42501`;
generic exceptions such as `P0001` are not accepted as authorization evidence.

For maintainers, `PROOF_DATABASE_URL=... node tests/postgres-integration.mjs`
after `pnpm build` exercises a separate temporary database against PostgreSQL,
including immediate and deferred failures and catalog ALTER/DROP behavior.

### 0.1.0-next.7 — audit hardening

Published release `0.1.0-next.7` tightens acceptance behavior. Trace
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
