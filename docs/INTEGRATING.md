# Integrating proof-harness into another project

Start with [the standalone example](../examples/authorization/README.md).
It demonstrates the evidence loop without requiring the original template.
Adopt only the layers your project needs; running the example is not a complete
acceptance gate.

## Choose a starting point

| Layer | What you supply | Current constraints |
| --- | --- | --- |
| Trace recording | Playwright specs, observations, explicit assertions | Node 24, Playwright, and its Supabase client peer; no browser needed for function-only tests |
| Mission validation | Requirements, capabilities, schema and trace artifacts | Closed vocabularies and versioned contracts; consult the SDK contract |
| Discovery and coverage | Supported source patterns, SQL history, coverage policies | Static discovery is conservative; arbitrary frameworks and SQL are not automatically supported |
| Mutation and control runners | Protected catalogs, passing baseline, local runtime and fixtures | Inspect the documented runtime requirements before adoption; the example does not configure these |
| Server and database helpers | Proof routes, authentication integration, disposable Supabase and schema inputs | Next.js/Supabase-oriented adapters; seed helpers have workspace-layout assumptions |

See [the SDK contract](../PROOF_SDK_CONTRACT.md) for exact APIs and
[compatibility notes](../COMPATIBILITY.md) for migrations and supported setup.
Use public subpath exports; importing internal CLI engines bypasses the public
API boundary.

## Divide ownership explicitly

The package owns trace formats, validation mechanics, helper assertions,
provenance handling, and verification engines. Your project owns the meaning
of success: product requirements, proof specs, policies, fixtures, action
registries, authentication, database rules, and mutation definitions.

Keep `proof.config.mjs`, catalogs, requirements, and acceptance policies under
review. Run acceptance from a trusted CI context that controls these inputs,
the pinned package, and evidence collection. A code-writing agent that can
rewrite the tests and gate can redefine success. Artifact provenance does not
remove that trust requirement.

## Adopt one real claim first

1. Pin an exact published prerelease and commit your lockfile. Read the migration
   notes for that version; never use `next`, `^`, or `~` for this package.
2. Choose an observable requirement, such as denying access across workspaces.
   Provide a valid allowed case as well, so a system that rejects everything
   cannot satisfy your intent unnoticed.
3. Write a proof against actual application behavior. Use SDK helpers where
   their documented assumptions fit. Explicit `recordAssertion` calls are
   consumer-authored evidence; they do not acquire helper provenance.
4. Confirm a clean passing run, then deliberately break the relevant behavior
   in a disposable environment. Check that the intended assertion fails.
   A setup error, timeout, or unrelated database error does not establish that
   the claim detected the defect.
5. Add the supported inventory and mutation workflow when ready. Supply your
   own protected catalog and runtime setup, collect a fresh baseline, and verify
   restoration. The teaching example's local script is not a replacement.
6. Keep ordinary tests, typechecking, review, and requirement acceptance in CI.
   The harness establishes the claims you configured, not overall correctness.

## Configure paths before adopting CLI engines

The default layout includes `app`, `e2e/proofs`, and `supabase/migrations`.
For a different source layout, begin with explicit paths, for example:

```js
// proof.config.mjs — consumer-owned, reviewed configuration
export default {
  roots: {
    source: 'src',
    actions: ['src/actions'],
    proofs: 'e2e/proofs',
    fixtures: 'e2e/fixtures',
    migrations: 'supabase/migrations',
  },
};
```

These paths are illustrative, not a complete mutation or server configuration.
Changing a path does not add support for a new action framework or SQL dialect.
Add only real directories and the catalog/provider settings your chosen engines
require. Unsupported discovery should block assessment, not be replaced with
invented capabilities or empty product defaults.

## When the integration does not fit

Report a small reproducer, the exact package and tool versions, the intended
claim, and the observed result. Explain which consumer-owned integration is
involved. Remove credentials and private data from logs and traces. A concrete
second consumer is a better basis for a new adapter than a speculative abstraction.
