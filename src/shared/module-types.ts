// Import External Packages
// Import Local Imports
import type { AppliedBy, ModuleKind } from "./vocabulary";
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// What a module declares about itself.
//
// Written to be read by a model rather than a person, and the reason is cost:
// without it a planner needs the codebase in its context, which grows with
// every extension we write. With it, a planner retrieves one small file.
//
// **Declare only what the code cannot say.** Tables, dependencies, actions and
// proof coverage are all derivable from source, and a written copy of a
// derivable fact is a fact that will be wrong later and say nothing about it.
// What is left — what this is FOR, and what must be settled before it can be
// used — is the part no compiler knows.
//
// Everything declared here is checked against the code by
// `pnpm proof:modules:check`. A descriptor that can be wrong silently is a
// liability with a nice format.
//
// Note on the name: "manifest" in this repo means the *mission* manifest
// (`.proof/current-mission.json`), which gates CI. This is a module
// *descriptor*, and the two are unrelated.
// ---------------------------------------------------------------------------

export const MODULE_DESCRIPTOR_SCHEMA_VERSION = 1;

/**
 * Where a buyer's answer has to land, so the code agent that applies it does
 * not have to rediscover the seams — and so a rename breaks CI instead of
 * quietly misleading the next agent.
 *
 * Two forms, both checkable:
 *
 *   "app/__core/legal-notices/src/pages/imprint.tsx"        — the file must exist
 *   "app/__core/user-auth/src/config.ts#MFA_POLICY"         — ...and contain that identifier
 *
 * Seams routinely sit **outside** the declaring module. Answering "we do not
 * need an Impressum" touches the page, its route, the shared footer and
 * `llm.txt`; an agent that only knows about `legal-notices` deletes one of the
 * four and leaves three links pointing at a 404. That is the whole reason this
 * field exists.
 */
export type ModuleSeam = string;

/**
 * Something the buyer chooses between before this module can be used.
 *
 * Declared by the module rather than known by the planner, so a planner's
 * context stays flat as the library grows from one extension to thirty.
 *
 * **A question the buyer cannot answer does not belong here.** Anything needing
 * technical judgement is a `ModuleDefault` and we own it; asking a dentist
 * about webhook retry semantics is not consultation, it is abdication.
 */
export interface ModuleDecision {
  /** snake_case, unique across every module. A planner keys answers by it. */
  id: string;
  /** In the buyer's language. They must be able to answer it unaided. */
  ask: string;
  /** Why it is being asked, in terms of what changes for them. */
  because: string;
  options: {
    value: string;
    /** What choosing this gets them, again in their language. */
    means: string;
  }[];
  /** How the answer reaches the code. The planner's cost signal. */
  applied_by: AppliedBy;
  /** Every place the answer lands. Checked to still exist. */
  applies: ModuleSeam[];
}

/**
 * A value the buyer supplies rather than picks — a legal name, a domain, a
 * support address.
 *
 * Separate from `decisions` because these are not choices and forcing them into
 * one would mean options that are not options. Separate from `defaults` because
 * nothing can be built until they exist: this is the planner's answer to "what
 * must I collect before I dispatch anything?".
 */
export interface ModuleInput {
  /** snake_case, unique across every module. */
  id: string;
  /** In the buyer's language. */
  ask: string;
  /** What breaks or looks wrong if it is left as shipped. */
  because: string;
  /** A concrete illustration, so nobody has to guess the format. */
  example: string;
  /** False when the template's placeholder is survivable for a while. */
  required: boolean;
  applies: ModuleSeam[];
}

/**
 * Something we decided on the buyer's behalf.
 *
 * Recorded rather than asked, so a planner can answer "what else could change?"
 * without putting a question in front of someone who has no opinion on invite
 * expiry windows. The code agent gets the seam either way.
 */
export interface ModuleDefault {
  /** snake_case, unique across every module. */
  id: string;
  /** What the template does today, in one plain sentence. */
  is: string;
  /** Where it is set. Checked to still exist. */
  where: ModuleSeam;
}

/**
 * The declared half — everything a person writes. The derived half is added by
 * `saasist-proof modules`.
 */
export interface ModuleMeta {
  /** Directory name. Checked against where the file sits. */
  id: string;
  kind: ModuleKind;
  /**
   * What this is for, in a sentence a buyer would recognise.
   *
   * The field a planner leans on hardest and the only one nothing can verify —
   * so it is short, and reviewed whenever the module changes.
   */
  purpose: string;
  /**
   * Environment variables this module needs.
   *
   * Declared rather than derived because need is transitive: the notification
   * system reaches Resend through `@shared/email`, so no grep of its own source
   * finds `RESEND_API_KEY`. Checked against `.env.local.example`, and anything
   * the module reads directly must appear here.
   */
  env: string[];
  decisions: ModuleDecision[];
  inputs: ModuleInput[];
  defaults: ModuleDefault[];
}

/**
 * A descriptor plus everything the scanner read from the source.
 *
 * This is what lands in `.proof/modules.json` and what a planner actually
 * reads. Nothing below `purpose` is hand-written.
 */
export interface ScannedModule extends ModuleMeta {
  /** Repo-relative, `/` separators. */
  path: string;
  /** Tables this module's own migrations create. */
  entities: string[];
  /** Core / extension / business modules it imports. Never declared. */
  requires: string[];
  /** Shared utilities it imports. Not installable, so not a dependency to order. */
  uses_shared: string[];
  /** From `capabilities.json`: what this module can be asked to do. */
  actions: { name: string; verb: string | null; object: string | null }[];
  /**
   * How battle-tested it is. Derived, and eventually the reason an installed
   * module costs a buyer less than a built one: somebody has already shown
   * these checks can fail.
   */
  proven: { specs: number; mutations: number };
}

/**
 * The generated artifact. Deterministic and unordered-by-nothing: every list is
 * sorted and there is no timestamp, so two runs on one tree are byte-identical.
 */
export interface ModulesArtifact {
  schemaVersion: number;
  modules: ScannedModule[];
  /**
   * Tables no descriptor claims — today the ones owned by `__shared` modules,
   * which are utilities nobody installs and so carry no descriptor.
   *
   * Listed rather than omitted. A planner that cannot see `audit_logs` will
   * eventually promise to build it.
   */
  unowned_tables: { table: string; module: string; path: string }[];
}
