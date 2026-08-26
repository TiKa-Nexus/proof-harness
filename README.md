# proof-harness

Prerelease verification and conformance toolkit for proof traces, missions,
fixtures, and Playwright probes.

This repository is the standalone source of the package. It requires Node 24
and pnpm 11.9.0:

```sh
pnpm install --frozen-lockfile
pnpm check
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

## License

Copyright 2026 SaaSist / botstrap-workbench.

Licensed under the [Apache License 2.0](./LICENSE).

## Distribution status

This repository remains private. No npm publication or template npm cutover has
been authorized. The manual prerelease workflow must not be dispatched.
