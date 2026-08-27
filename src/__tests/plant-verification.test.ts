// Import External Packages
import { describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
import {
  assessPlantedSubject,
  assessSubjectAfterProof,
} from "../../cli/engines/proof_plant_verification.mjs";
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// A mutation run is only evidence when the planted defect was live for the
// whole proof. These tests pin the three-snapshot verdicts (before apply,
// after apply, after proof) that keep an ineffective or externally-undone
// plant from being reported as "MISSED" — the failure mode of issue #7, where
// a REVOKE that was not in effect made a working proof look vacuous.
// ---------------------------------------------------------------------------

const subject = {
  id: "LESSON-DELETE-DENIED",
  description: "DELETE on public.lessons for authenticated",
};

describe("assessPlantedSubject", () => {
  it("accepts an apply that visibly changed the subject", () => {
    expect(
      assessPlantedSubject({ ...subject, before: "t", afterApply: "f" }),
    ).toBeNull();
  });

  it("refuses an apply that left the subject unchanged", () => {
    const message = assessPlantedSubject({
      ...subject,
      before: "t",
      afterApply: "t",
    });
    expect(message).toContain("NOT PLANTED");
    expect(message).toContain(subject.id);
    expect(message).toContain(subject.description);
    // The operator must be pointed at plant-level causes, not at the proof.
    expect(message).toContain("PUBLIC or an inherited role");
  });

  it("accepts an unchanged subject when the mutation declares it", () => {
    expect(
      assessPlantedSubject({
        ...subject,
        before: "t",
        afterApply: "t",
        applyDoesNotChangeSubject: true,
      }),
    ).toBeNull();
  });

  it("refuses a wrong applyDoesNotChangeSubject declaration", () => {
    const message = assessPlantedSubject({
      ...subject,
      before: "t",
      afterApply: "f",
      applyDoesNotChangeSubject: true,
    });
    expect(message).toContain("applyDoesNotChangeSubject");
    expect(message).toContain("remove it");
  });
});

describe("assessSubjectAfterProof", () => {
  it("accepts a defect that stayed live through the proof", () => {
    expect(
      assessSubjectAfterProof({
        ...subject,
        before: "t",
        afterApply: "f",
        afterProof: "f",
      }),
    ).toBeNull();
  });

  it("refuses a subject that reverted to its pre-mutation state mid-run", () => {
    const message = assessSubjectAfterProof({
      ...subject,
      before: "t",
      afterApply: "f",
      afterProof: "t",
    });
    expect(message).toContain("UN-PLANTED");
    expect(message).toContain("not a missed proof");
  });

  it("refuses a subject that drifted to a third state mid-run", () => {
    const message = assessSubjectAfterProof({
      id: "MUT-TRIGGER",
      description: "trigger audit on public.lessons",
      before: "CREATE TRIGGER audit ...",
      afterApply: "",
      afterProof: "CREATE TRIGGER audit_v2 ...",
    });
    expect(message).toContain("cannot be attributed");
  });

  it("holds a declared unchanged subject to its original state", () => {
    expect(
      assessSubjectAfterProof({
        ...subject,
        before: "t",
        afterApply: "t",
        afterProof: "t",
        applyDoesNotChangeSubject: true,
      }),
    ).toBeNull();
    const message = assessSubjectAfterProof({
      ...subject,
      before: "t",
      afterApply: "t",
      afterProof: "f",
      applyDoesNotChangeSubject: true,
    });
    expect(message).toContain("cannot be attributed");
  });
});
