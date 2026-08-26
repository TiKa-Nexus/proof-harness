# Proof consumer conformance fixtures

This directory is the executable ingestion contract for systems that download
`proof-traces` and `proof-traces-mutated`. The prose contract remains
[`PROOF_SDK_CONTRACT.md`](../PROOF_SDK_CONTRACT.md); `corpus.json` names each
case and its expected classification or rejection.

## What the corpus covers

- a passing and a failing per-spec `TraceArtifact`
- passing and failing mission aggregates containing those traces
- a mutation directory whose trace deliberately reuses the baseline filename
- two valid traces with the same `proofId`
- invalid JSON, a wrong trace shape, and an unsupported manifest version

The small `inputs/` artifacts let the passing and failing traces run through the
same `validateMission` implementation used by `pnpm proof:verify`.

## Required ingestion behavior

1. Parse JSON without repairing or defaulting malformed input.
2. Classify before accumulating. A per-spec trace has `schemaVersion: 2` and a
   `steps` array; a mission aggregate has `schemaVersion: 1` plus `proofs` and
   `traces` arrays. Never count the aggregate itself as another trace.
3. Keep normal and mutation artifacts in separate namespaces. The mutation
   trace intentionally has the same filename and `proofId` as the passing
   baseline trace.
4. Preserve and cross-check mutation identity. The directory name,
   `mutation.json.id`, and every trace's `mutation.id` must agree, and
   `mutation.planted` must be `true`.
5. Reject duplicate `proofId` values in one baseline bundle before writing to a
   map or database. Last-write-wins loses evidence and provenance.
6. Read a mission verdict from the aggregate's top-level `passed` boolean, not
   file presence or the HTTP/check status alone. Keep `issues` on failure.
7. Retain `requirementEvidence`. Every satisfied entry must resolve to the named
   `proofId`/`specFile` and to a passing assertion with the same
   `kind`/`target`/`role` inside `traces`.
8. Treat mutation traces as detection evidence, never as mission evidence. A
   red mutation trace is expected when `mutation.json.detected` is `true`.

`corpus.json` uses stable expected error labels (`invalid_json`,
`trace_shape`, and `duplicate_proof_id`) for conformance assertions. Consumers
may expose different public error names, but must reject the same inputs for the
same reasons.

## Running the reference checks

```bash
pnpm exec vitest run scripts/__tests/proof-consumer-fixtures.test.ts
```

External orchestrators should run this same directory through their production
ingestion path and assert the outcomes in `corpus.json`. Template tests prove
that the fixtures agree with the canonical mission validator; they cannot prove
that another system preserves the same classifications after download,
extraction, storage, or deduplication.

GitHub token permissions, check-run classification, and repository-readiness
polling are intentionally outside this corpus because they are integration
policy rather than evidence format behavior.
