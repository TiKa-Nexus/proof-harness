// Import External Packages
import { describe, expect, it, vi } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import {
  PROOF_COMMIT_ENV,
  PROOF_DIRTY_ENV,
  resolveCodeProvenance,
} from "../server/code-provenance";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// A trace that cannot say which commit it observed is a claim about nothing in
// particular. These tests pin the two rules that make the field trustworthy:
// the runner's answer wins (so every trace in one run agrees), and an unknown
// value is left absent rather than guessed.
// ---------------------------------------------------------------------------

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("resolveCodeProvenance", () => {
  it("prefers what the runner resolved, without touching git", () => {
    const git = vi.fn();
    const result = resolveCodeProvenance(
      { [PROOF_COMMIT_ENV]: SHA, [PROOF_DIRTY_ENV]: "false" },
      git,
    );
    expect(result).toEqual({ commit: SHA, dirty: false });
    expect(git).not.toHaveBeenCalled();
  });

  it("carries a dirty tree through from the runner", () => {
    const result = resolveCodeProvenance(
      { [PROOF_COMMIT_ENV]: SHA, [PROOF_DIRTY_ENV]: "true" },
      vi.fn(),
    );
    expect(result).toEqual({ commit: SHA, dirty: true });
  });

  it("omits dirty when the runner could not tell", () => {
    // Absent and `false` mean different things: one is "clean", the other is
    // "nobody knows", and a consumer gating on cleanliness needs to see the
    // difference.
    const result = resolveCodeProvenance({ [PROOF_COMMIT_ENV]: SHA }, vi.fn());
    expect(result).toEqual({ commit: SHA });
    expect("dirty" in result).toBe(false);
  });

  it("asks git when run directly, outside the runner", () => {
    const git = vi.fn((args: string[]) =>
      args[0] === "rev-parse" ? `${SHA}\n` : "",
    );
    expect(resolveCodeProvenance({}, git)).toEqual({
      commit: SHA,
      dirty: false,
    });
    expect(git).toHaveBeenCalledWith(["rev-parse", "HEAD"]);
    expect(git).toHaveBeenCalledWith(["status", "--porcelain"]);
  });

  it("reads a non-empty status as a dirty tree", () => {
    const git = vi.fn((args: string[]) =>
      args[0] === "rev-parse" ? `${SHA}\n` : " M app/page.tsx\n",
    );
    expect(resolveCodeProvenance({}, git)).toEqual({
      commit: SHA,
      dirty: true,
    });
  });

  it("returns nothing at all outside a git checkout", () => {
    // Exported tarballs and shallow images must still write usable traces, so a
    // missing SHA weakens the evidence rather than failing the run.
    expect(resolveCodeProvenance({}, () => undefined)).toEqual({});
  });

  it("omits dirty when git answered the commit but not the status", () => {
    const git = vi.fn((args: string[]) =>
      args[0] === "rev-parse" ? `${SHA}\n` : undefined,
    );
    const result = resolveCodeProvenance({}, git);
    expect(result).toEqual({ commit: SHA });
  });

  it("ignores a blank runner value rather than recording an empty commit", () => {
    const git = vi.fn(() => undefined);
    expect(resolveCodeProvenance({ [PROOF_COMMIT_ENV]: "  " }, git)).toEqual(
      {},
    );
    expect(git).toHaveBeenCalled();
  });
});
