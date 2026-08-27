# Compatibility

| `proof-harness` | Trace artifact schema | Mission manifest schema | Proof health protocol | Node.js |
| --- | ---: | ---: | ---: | --- |
| `0.1.x` | 2 | 1 | 1 | 24 |

## Prerelease consumers

Consumers must pin an exact prerelease version, for example:

```json
{
  "devDependencies": {
    "proof-harness": "0.1.0-next.4"
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
