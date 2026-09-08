# Contributing

proof-harness is an opinionated prerelease project developed alongside a real
consumer template. Contributions that make supported behavior reliable and
understandable are welcome. Broad framework support is not yet a promise.

## Local setup

Use Node 24 (see `.nvmrc`) and pnpm 11.9.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
```

The complete check builds the public exports, typechecks, lints, and runs unit,
conformance, and packed-package tests. Some checks start local test servers;
packed-package checks install dependencies and may need network access. Run
`pnpm check` before every commit or PR. Read [AGENTS.md](./AGENTS.md) for the
repository's ownership and compatibility rules.

For a focused iteration, use `pnpm test`, `pnpm conformance`, or
`pnpm pack:check` as appropriate; build first when testing packaged exports.
The [standalone example](./examples/authorization/README.md) has its own install
and demo commands. It is a repository example, not part of the published runtime.

## Good first contributions

- Run the example on a clean machine and improve instructions where you get stuck.
- Add a minimal reproducer and regression fixture for a malformed-evidence bug.
- Document a real integration constraint encountered in another project.

These are suggested starting points, not claims that corresponding issues are
already open. For a new framework adapter or API redesign, open an issue with
an actual consumer use case before investing in a large implementation.

## Proposing a change

Keep PRs focused. Explain the problem, resulting behavior, and checks run.
Preserve fail-closed evidence handling and public subpath boundaries. Do not
add template-specific fixtures, credentials, or product defaults to the runtime.
Changes to serialized contracts need conformance fixtures first; consumer
migrations belong in [COMPATIBILITY.md](./COMPATIBILITY.md).

For bug reports, include the exact package version, Node/pnpm versions,
minimal reproduction, expected outcome, and sanitized actual output. Report
security-sensitive details privately through GitHub's security reporting option
if enabled; otherwise ask the maintainer for a private reporting channel without
posting exploit details or secrets publicly.

Releases use reviewed exact prerelease versions and the protected publishing
workflow. Documentation-only contributions do not need a version bump. The
maintainer handles publishing and the required environment approval.

Contributions are under the repository's [Apache-2.0 license](./LICENSE).
