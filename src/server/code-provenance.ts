// Import External Packages
import { spawnSync } from "node:child_process";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Which code did this proof observe?
//
// A trace says "the outsider could not read the row". On its own that is a claim
// about nothing in particular: without the commit, a reader cannot tell whether
// it describes the PR under review, the branch point, or a working tree that has
// since been edited. `specHash` pins the spec that made the claim; this pins the
// application it was made against.
//
// Two facts, both optional:
//
//   commit — the SHA that was checked out while the proof ran.
//   dirty  — whether the working tree had uncommitted changes at that moment. A
//            green proof from a dirty tree describes no reviewable commit, so a
//            consumer that gates on evidence needs to be able to refuse it. It
//            is not the same information as `commit`, and it is the field people
//            forget to ask for.
//
// Absent rather than fabricated when unknown: shallow clones, exported tarballs
// and non-git checkouts all have to keep producing usable artifacts, so a missing
// SHA weakens the evidence instead of failing the run.
// ---------------------------------------------------------------------------

export interface CodeProvenance {
  commit?: string;
  dirty?: boolean;
}

/** Environment variables `proof-harness verify` sets for the spec run. */
export const PROOF_COMMIT_ENV = "PROOF_COMMIT";
export const PROOF_DIRTY_ENV = "PROOF_DIRTY";

type GitReader = (args: string[]) => string | undefined;

const readGit: GitReader = (args) => {
  try {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
};

/**
 * Resolve provenance, preferring what the runner already worked out.
 *
 * The runner path matters for more than speed. `proof_verify.mjs` reads git once
 * for the whole run, so every trace in one run agrees; letting each spec ask git
 * for itself would let `dirty` flip mid-run as files are written, and two traces
 * from the same run could then disagree about the code they observed.
 *
 * The git fallback exists because specs are also run directly —
 * `pnpm exec playwright test e2e/proofs/foo.proof.ts` — and a trace written that
 * way should not silently lose its provenance.
 */
export function resolveCodeProvenance(
  // Deliberately not NodeJS.ProcessEnv: the app augments that type with required
  // keys, and this reads two optional variables that have nothing to do with the
  // application's own configuration.
  env: Record<string, string | undefined> = process.env,
  git: GitReader = readGit,
): CodeProvenance {
  const fromRunner = env[PROOF_COMMIT_ENV]?.trim();
  if (fromRunner) {
    const dirty = env[PROOF_DIRTY_ENV]?.trim();
    return {
      commit: fromRunner,
      // Only "true"/"false" carry meaning; anything else means the runner could
      // not tell, which is different from "clean".
      ...(dirty === "true" || dirty === "false"
        ? { dirty: dirty === "true" }
        : {}),
    };
  }

  const commit = git(["rev-parse", "HEAD"])?.trim();
  if (!commit) return {};

  const status = git(["status", "--porcelain"]);
  return {
    commit,
    ...(status === undefined ? {} : { dirty: status.trim().length > 0 }),
  };
}

let cached: CodeProvenance | undefined;

/**
 * Cached `resolveCodeProvenance` for the writer path.
 *
 * Playwright workers are separate processes, so this is one git call per worker
 * at worst — and none at all when the runner supplied the values.
 */
export function codeProvenance(): CodeProvenance {
  cached ??= resolveCodeProvenance();
  return cached;
}
