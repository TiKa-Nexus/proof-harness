# @saasist/proof

Prerelease Proof SDK for SaaSist verification and conformance tests.

This repository is the standalone source of the package. It requires Node 24
and pnpm 11.9.0:

```sh
pnpm install --frozen-lockfile
pnpm check
```

The package exposes environment-specific entry points:

- `@saasist/proof/shared` — portable types and vocabularies
- `@saasist/proof/node` — Node mission validation helpers
- `@saasist/proof/playwright` — Playwright proof assertions and traces
- `@saasist/proof/server` — server-side fixtures, guards, and service clients
- `@saasist/proof/portable-vocabulary` — dependency-free runtime constants

See [PROOF_SDK_CONTRACT.md](./PROOF_SDK_CONTRACT.md) for the consumer contract
and [COMPATIBILITY.md](./COMPATIBILITY.md) for protocol/schema compatibility
and consumer pinning requirements.

The package also publishes one `saasist-proof` executable with `scan`, `parse`,
`registry`, `build`, `verify`, `coverage`, `inventory`, `drift`, `modules`,
`modules-check`, and `mutate` subcommands. Commands read repository paths from
`proof.config.mjs`; without one they use the SaaSist template layout. Product
migration aggregation and explicit mutation definitions remain repository-owned
trust inputs rather than package defaults.

Named seed actors (`"admin"` and `"member"`) read
`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` and
`SEED_MEMBER_EMAIL`/`SEED_MEMBER_PASSWORD` from the consumer environment. The
package does not ship product seed credentials.

## Publishing gate

The package is currently `UNLICENSED`. Do not publish it until a human has
chosen the public license and configured the `@saasist` npm scope, npm 2FA, and
this repository as an npm trusted publisher. The manual prerelease workflow
uses GitHub OIDC and npm provenance; it intentionally has no long-lived npm
token.
