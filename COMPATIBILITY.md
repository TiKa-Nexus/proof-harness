# Compatibility

| `proof-harness` | Trace artifact schema | Mission manifest schema | Proof health protocol | Node.js |
| --- | ---: | ---: | ---: | --- |
| `0.1.x` | 2 | 1 | 1 | 24 |

## Prerelease consumers

Consumers must pin an exact prerelease version, for example:

```json
{
  "devDependencies": {
    "proof-harness": "0.1.0-next.5"
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
