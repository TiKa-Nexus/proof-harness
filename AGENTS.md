# AGENTS.md — proof-harness

This repository is the canonical source for the public `proof-harness` npm
package. It owns reusable verification mechanics; consumer repositories own
their product claims and trust inputs.

## Ownership

- Own the public entry points (`shared`, `node`, `playwright`, `server`,
  `portable-vocabulary`), the CLI engines under `cli/`, trace/mission
  contracts, assertions, provenance, conformance fixtures, package tests,
  docs, and release prep.
- Do not own consumer proof specs, product fixtures, action registries,
  missions, policies, mutation catalogs, authentication, database rules, or
  UI. `proof.config.mjs` and the protected mutation catalog are
  repository-owned trust inputs; never invent product defaults for them.
- Split cross-repository defects at that boundary and link the related
  issues.

## Compatibility

- Consumers pin exact prerelease versions (`0.1.0-next.N`); never recommend
  `next`, `^`, or `~` while the API is prerelease.
- Preserve closed vocabularies, assertion provenance, and fail-closed
  evidence semantics: malformed, stale, incomplete, or unassessable evidence
  is non-evidence. Never weaken a proof or trust boundary to make a consumer
  pass.
- Add conformance fixtures before changing a serialized contract; trace,
  mission, and health protocol versions are independent of the npm version.
- The harness never invents a column value it wasn't given: anywhere it
  writes to a consumer-owned table, values come from the caller or config,
  or the column is omitted. Tenancy shape is a consumer decision.
- Document every required consumer migration in `COMPATIBILITY.md`.

## Development

- Requires Node 24 and pnpm 11.9.0 (`.nvmrc`, `packageManager`).
- Run `pnpm install --frozen-lockfile` before development.
- Run `pnpm check` before every commit or PR — it builds, typechecks, lints,
  and runs unit, conformance, and packed-package tests.
- Keep environment-specific dependencies behind the existing subpath exports;
  validate the packed package, not only source-tree imports.

## Releases

- Prepare exact `0.1.0-next.N` versions through reviewed, focused PRs with
  migration notes.
- Publish only from `main` by dispatching `publish-next.yml` (npm Trusted
  Publishing with provenance). A human approves the protected `npm`
  environment.
- Never publish, retag, or broaden package access merely to unblock a test.
- After publishing, verify npm provenance and notify consumers of the exact
  version and required integration changes.
