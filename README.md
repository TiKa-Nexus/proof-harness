# proof-harness

Verification tools for making specific claims about agent-generated code—and
checking that deliberately broken behavior makes those claims fail.

Developed alongside a consumer template, this is an opinionated prerelease,
not a universal agent acceptance system. It can help teams that already have
executable requirements and want structured evidence, coverage checks, and
mutation checks around them.

## Try it without the template

The [standalone authorization example](https://github.com/TiKa-Nexus/proof-harness/tree/main/examples/authorization)
uses a tiny JavaScript rule and the public package. It needs Node 24 and pnpm
11.9.0; no database, credentials, app server, or browser download.

```sh
git clone https://github.com/TiKa-Nexus/proof-harness.git
cd proof-harness/examples/authorization
pnpm install
pnpm demo
```

You will see a passing proof, an intentionally failed proof after the rule is
broken, and confirmation that the source was restored. The example validates
recorded evidence; it is an introduction, not the full CLI mutation workflow.

## What it does—and what it establishes

The harness records structured proof traces, validates evidence and missions,
and provides coverage, drift, mutation, and control-sensitivity engines.
It can establish that a configured claim was observed and that a mapped defect
was detected. The consuming project supplies the requirements and trust inputs.

A passing trace does not establish overall correctness, adequate requirements,
or security against an agent that can rewrite the acceptance gate. Keep code
review, conventional tests, and trusted CI alongside it. See the
[integration guide](https://github.com/TiKa-Nexus/proof-harness/blob/main/docs/INTEGRATING.md)
for ownership, adoption steps, and current environment constraints, and
[contributor guide](https://github.com/TiKa-Nexus/proof-harness/blob/main/CONTRIBUTING.md)
for setup and approachable contributions.

## Installation

Public prereleases are published under the npm `next` tag. Pin an exact
prerelease version while the API is stabilizing:

```sh
pnpm add proof-harness@0.1.0-next.9
```

The package exposes environment-specific entry points:

- `proof-harness/shared` — portable types and vocabularies
- `proof-harness/node` — Node mission validation and local PostgreSQL helpers
- `proof-harness/playwright` — Playwright proof assertions and traces
- `proof-harness/server` — server-side fixtures, guards, and service clients
- `proof-harness/portable-vocabulary` — dependency-free runtime constants

See [PROOF_SDK_CONTRACT.md](./PROOF_SDK_CONTRACT.md) for the consumer contract
and [COMPATIBILITY.md](./COMPATIBILITY.md) for protocol/schema compatibility
and consumer pinning requirements.

## Portability map

The package has two layers; consumers should know which one they are leaning
on:

- **Reusable verification mechanics** — trace recording and the assertion
  vocabulary, mission validation, coverage and its ratchet, drift, mutation
  testing, and the CLI. These read your generated schema and config, or take
  what you give them. CLI discovery supports specific source and SQL patterns;
  configurable paths do not make every framework compatible.
- **Assumes the conventional Supabase/workspace layout** — `seed.*` (a
  `workspaces` table with a `name` column, a `workspace_members` join table,
  and a `public.users` mirror maintained by a `handle_new_user` trigger) and
  `assert.tenantIsolation`, which seeds through those helpers. The seed
  helpers never invent column values: a schema that requires more than the
  helpers are given states it via `seed.workspace(name, { columns })` or
  `workspaceColumns` on `assert.tenantIsolation`.

The `/api/proof/*` routes and the `NEXT_PUBLIC_SUPABASE_URL` /
`SUPABASE_SECRET_KEY` environment names are documented protocol rather than
template leakage.

`createProofServiceClient` refuses every non-local Supabase target
(`unsafe_database`): the proof suite deletes the auth users and workspaces it
seeds, so a hosted project must never be reachable. A genuinely disposable
non-local host — a docker-network hostname in CI — is allowed explicitly in
code via `allowProofServiceHosts`; there is deliberately no environment
override.

The package also provides one `proof-harness` executable with `scan`, `parse`,
`registry`, `build`, `verify`, `coverage`, `inventory`, `drift`, `mutate`, and `controls`
subcommands. Commands read repository paths from
`proof.config.mjs`; without one they use a conventional application layout.
Product migration aggregation and explicit mutation definitions remain
repository-owned trust inputs rather than package defaults.

Named seed actors (`"admin"` and `"member"`) read
`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` and
`SEED_MEMBER_EMAIL`/`SEED_MEMBER_PASSWORD` from the consumer environment. The
package does not ship product seed credentials.

Disposable users that authenticate a Playwright page must call
`actAsUser.logout(page)` before their auth row is deleted.
`assert.tenantIsolation({ page })` performs that browser cleanup automatically;
the page is logged out when the helper returns.

## Optional isolated parallel execution

The next.14 release candidate adds spec-based sharding without changing the
serial workflow. Adopt it only after review and publication; see the
[required integration and parity checks](COMPATIBILITY.md#010-next14--isolated-parallel-proof-gate-release-candidate).

The consumer supplies its own post-run commands in `proof.config.mjs`. For
example, if these scripts exist and cover its database and browser controls:

```js
export default {
  // Existing paths, catalogs and trust inputs remain here.
  parallel: {
    postChecks: [
      ["pnpm", "test:permissions"],
      ["pnpm", "test:profile-permissions"],
    ],
  },
};
```

After the existing environment setup and structural preflight, create a plan:

```sh
pnpm exec proof-harness plan --shards 6 \
  --controls-config proof.controls.config.mjs \
  --out .proof/parallel/plan.json
```

Upload the plan for the shard jobs. Each gets a separate checkout, local
Supabase stack and fake services. After its normal setup and preflight,
download the plan and run these commands with its zero-based matrix index:

```sh
pnpm exec proof-harness verify --plan .proof/parallel/plan.json --shard 0
pnpm exec proof-harness mutate --plan .proof/parallel/plan.json --shard 0
pnpm exec proof-harness controls --plan .proof/parallel/plan.json --shard 0
pnpm exec proof-harness finalize --plan .proof/parallel/plan.json --shard 0
```

Make `finalize` an `if: always()` step, followed by an always-run artifact upload
of `.proof/parallel/shard-0/` including hidden files. Store each shard under its
own name and download them as `inputs/shard-0`, `inputs/shard-1`, etc. under
`.proof/parallel/`. Upload only the plan from the planning job; never distribute
`environment.json` or `active-stage.lock` between runners. Use six matrix values
`[0, 1, 2, 3, 4, 5]` with `fail-fast: false`; use fewer for a smaller repository.
The final job downloads all shards and the plan, regenerates discovery inputs,
and runs:

```sh
pnpm exec proof-harness aggregate --plan .proof/parallel/plan.json \
  --inputs .proof/parallel/inputs
```

The final job must run even when a shard fails, and its status must also require
successful planning and shard jobs. Only this complete gate replaces the
consumer's existing required Proof check. Keep consumer structural, database
baseline and pre-mutation permission checks in the workflow; `aggregate`
validates the complete baseline/mission, strict coverage, independently derived
mutation inventories, mapped failures, restoration and configured postchecks.

GitHub's run ID and attempt identify the run automatically. For local tests,
set a unique `PROOF_RUN_ID` in every checkout for the same run. Local shards need
distinct servers and databases as well as checkouts. Do not run multiple shards
against one mutable environment, even if their traces use different folders.

Successful aggregation writes an acceptance report with stage durations, slow
specs and total runner time under `.proof/parallel/aggregate-*/acceptance.json`.
Pass a previous report with `plan --history <file>` to balance by measured spec
costs. History changes scheduling only; current source and catalogs determine
all required work. Mutation execution reports retain attempts and first errors;
SDK fixture setup/cleanup steps provide additional diagnostics. Startup and
compilation remain part of readiness/execution where no separate measurement
exists. An 18-minute lane warning signals that CI overhead may push the overall
Proof job beyond a 20-minute budget.

This is additional parallel capacity, not a fixed runtime guarantee. Benchmark
with the consumer before switching its required gate, and compare total billed
runner-minutes as well as elapsed time. Keep caches limited to dependencies;
do not reuse evidence, database state or mutable application builds.

## License

Copyright 2026 The Nexus Collective GmbH.

Created and maintained by Till Kahlen at
[The Nexus Collective GmbH](https://nexuscollective.io).

Licensed under the [Apache License 2.0](./LICENSE).

## Release status

The package is released from this public repository with npm provenance.
Prerelease consumers must pin an exact version rather than using `next`, `^`, or
`~`; see [COMPATIBILITY.md](./COMPATIBILITY.md) for the compatibility policy.

## Audit hardening (0.1.0-next.7)

This release adds shared fail-closed trace ingestion, source freshness,
stronger authorization probes, isolated mutation evidence and interruption
recovery, conservative discovery, and package-owned drift regeneration.
See [required migration changes](COMPATIBILITY.md#010-next7--audit-hardening)
before upgrading a consumer. In particular, existing traces must be rerun and
unsupported SQL now blocks assessment.

Release `0.1.0-next.8` adds direct RLS client and Auth-admin discovery,
a consumer-owned catalog provider for full SQL histories, and transactional
INSERT controls for append-only tables. Pin exactly
`proof-harness@0.1.0-next.8`. See [compatibility and setup](COMPATIBILITY.md#010-next8)
for the required consumer changes.

The harness establishes specific tested claims. Acceptance still requires
consumer-owned requirements and a trusted CI job that controls the harness,
policies, and evidence. A passing trace is not a general proof of code quality
or a defense against an executor that can rewrite the acceptance gate.


Release `0.1.0-next.9` adds isolated anonymous action probes and a
separate positive-control sensitivity runner. It also distinguishes caller
workspace inputs from generated result IDs. See [next.9 setup and migration](COMPATIBILITY.md)
before upgrading; consumer invoker and catalog changes are required.

Release `0.1.0-next.10` restores explicit consumer primary assertions
for mutation detection while retaining strict control provenance. See the
[next.10 migration notes](COMPATIBILITY.md) before adopting it.

Release `0.1.0-next.11` discovers direct service RPC calls as potentially
privileged writes and requires action-boundary evidence even without workspace
inputs or for internal actions. See [required migration steps](COMPATIBILITY.md)
before adopting the exact version.

Release `0.1.0-next.12` adds caller-owned account/user isolation fixtures
and restores column grants and grant options after table-privilege mutations.
See [migration requirements](COMPATIBILITY.md).

Release candidate `0.1.0-next.13` adds optional readable-column selection to
`assert.tenantIsolation` for tables with column grants. Private-column denial
remains a separate consumer proof; see [migration requirements](COMPATIBILITY.md).
