// Node-only entry point for the Proof SDK.
//
// Helpers used by `scripts/*.mjs` CLI tools and CI gates. Pure Node, no
// Next/React/Playwright dependencies.

export { validateMission, collectAssertions } from "./validate-mission";
export type {
  CapabilitiesArtifact,
  SchemaArtifact,
  TraceBundle,
  ValidateMissionInput,
} from "./validate-mission";

export {
  decodeTrace,
  decodeTraceBundle,
  traceShapeIssues,
  readTraceDirectory,
  baselineAssertions,
  assertionPassed,
  isArtifactId,
} from "./evidence";
export { sourceHash } from "./source-hash";
export {
  withLocalPostgres,
  readPostgresCatalog,
  rollbackInsertControl,
  quotePostgresIdentifier,
} from "./postgres";

export type { PostgresCatalogPolicy, PostgresCatalogTable } from "./postgres";
