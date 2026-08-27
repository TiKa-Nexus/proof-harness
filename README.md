# proof-harness

Prerelease verification and conformance toolkit for proof traces, missions,
fixtures, and Playwright probes.

This repository is the standalone source of the package. It requires Node 24
and pnpm 11.9.0:

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Installation

Public prereleases are published under the npm `next` tag. Pin an exact
prerelease version while the API is stabilizing:

```sh
pnpm add proof-harness@0.1.0-next.2
```

The package exposes environment-specific entry points:

- `proof-harness/shared` — portable types and vocabularies
- `proof-harness/node` — Node mission validation helpers
- `proof-harness/playwright` — Playwright proof assertions and traces
- `proof-harness/server` — server-side fixtures, guards, and service clients
- `proof-harness/portable-vocabulary` — dependency-free runtime constants

See [PROOF_SDK_CONTRACT.md](./PROOF_SDK_CONTRACT.md) for the consumer contract
and [COMPATIBILITY.md](./COMPATIBILITY.md) for protocol/schema compatibility
and consumer pinning requirements.

The package also provides one `proof-harness` executable with `scan`, `parse`,
`registry`, `build`, `verify`, `coverage`, `inventory`, `drift`, `modules`,
`modules-check`, and `mutate` subcommands. Commands read repository paths from
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

## License

Copyright 2026 The Nexus Collective GmbH.

Created and maintained by Till Kahlen at
[The Nexus Collective GmbH](https://nexuscollective.io).

Licensed under the [Apache License 2.0](./LICENSE).

## Release status

The package is released from this public repository with npm provenance.
Prerelease consumers must pin an exact version rather than using `next`, `^`, or
`~`; see [COMPATIBILITY.md](./COMPATIBILITY.md) for the compatibility policy.
