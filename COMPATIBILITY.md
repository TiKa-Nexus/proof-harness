# Compatibility

| `@saasist/proof` | Trace artifact schema | Mission manifest schema | Proof health protocol | Node.js |
| --- | ---: | ---: | ---: | --- |
| `0.1.x` | 2 | 1 | 1 | 24 |

## Prerelease consumers

Consumers must pin an exact prerelease version, for example:

```json
{
  "devDependencies": {
    "@saasist/proof": "0.1.0-next.1"
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
