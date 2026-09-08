# Standalone authorization example

A tiny consumer of the public package: no template, Next.js app, Supabase,
credentials, or browser download. Requires Node 24 and pnpm 11.9.0.
The Playwright entry point imports the Supabase client library, so this example
installs that peer dependency even though it makes no database requests.

From this directory (or after copying it into its own directory):

```sh
pnpm install
pnpm demo
```

The example pins published `proof-harness@0.1.0-next.9`. It uses trace recording,
not the primary mutation matcher fixed in next.10. Commit the generated lockfile
if you adopt this example as a project.

The demo runs the proof against a correct workspace access rule, temporarily
replaces that rule with `return true`, and runs the same proof again. The second
Playwright run intentionally reports a failure. The demo succeeds only when
both process outcomes and decoded primary assertions match expectations. Its
last message confirms detection and restoration. Each run writes inspectable
JSON evidence beneath a new `.proof-demo-*` directory.

`access.mjs` is the application; `access.spec.mjs` owns its claims and observations.
The harness records structured traces, and `decodeTrace` validates their shape.
These direct assertions have no SDK-helper provenance. The allowed-owner check
is a consumer-authored control, not evidence for the SDK `controls` command.

This is a teaching script, not `proof-harness mutate`: it does not establish
mutation inventory, source freshness, database isolation, or crash recovery.
It restores the source in `finally`; a forced process kill can prevent that.
Run it in a disposable copy. If interrupted, restore `access.mjs` before rerunning.
A failed process alone is not sufficient: missing or malformed traces also fail
the demo instead of counting as detection.

Continue with the [integration guide](../../docs/INTEGRATING.md) to build a
protected acceptance workflow for your own application.
