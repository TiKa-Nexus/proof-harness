// Shared entry point for the Proof SDK.
//
// Pure types and closed vocabularies. Safe to import from any environment
// (server, Playwright spec, Node CLI, browser).

export {
  PROOF_VERBS,
  PROOF_KINDS,
  RLS_CLASSIFICATIONS,
  MODULE_KINDS,
  APPLIED_BY,
  isProofVerb,
  isProofKind,
  isRlsClassification,
  isModuleKind,
  isAppliedBy,
} from "./vocabulary";

export type {
  ProofVerb,
  ProofKind,
  RlsClassification,
  ModuleKind,
  AppliedBy,
} from "./vocabulary";

export type {
  AssertionRole,
  AssertionStatus,
  ProofOperation,
  ProofOptions,
  TraceStep,
  TraceArtifact,
  TraceMutation,
  TraceAssertion,
  TraceRecorder,
  StepOptions,
  StepResult,
} from "./trace-types";
export {
  ASSERTION_ROLE_ALIASES,
  TRACE_ARTIFACT_SCHEMA_VERSION,
  normalizeAssertionRole,
  normalizeAssertionStatus,
  TENANT_ISOLATION_ACTION_HELPERS,
  TENANT_ISOLATION_TABLE_HELPERS,
} from "./trace-types";

export type { ActionResult, InvokeActionRequest } from "./action-types";

export { MISSION_MANIFEST_SCHEMA_VERSION } from "./mission-types";
export type {
  MissionManifest,
  MissionRequirements,
  CapabilityRequirement,
  SchemaRequirement,
  TraceRequirement,
  ValidationIssue,
  ValidationResult,
  ValidationCategory,
} from "./mission-types";

export { MODULE_DESCRIPTOR_SCHEMA_VERSION } from "./module-types";
export type {
  ModuleMeta,
  ModuleDecision,
  ModuleInput,
  ModuleDefault,
  ModuleSeam,
  ScannedModule,
  ModulesArtifact,
} from "./module-types";
