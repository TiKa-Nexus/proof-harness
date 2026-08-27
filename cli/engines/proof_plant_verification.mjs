// ---------------------------------------------------------------------------
// proof_plant_verification.mjs
//
// A mutation run is only evidence if the planted defect was actually live for
// the entire proof. These checks compare the subject's snapshot at three
// moments — before apply, after apply, and after the proof — and turn every
// silent mismatch into a structured, correctly-attributed failure instead of
// letting it masquerade as "MISSED — the proof cannot fail":
//
//   - apply changed nothing       → the defect never went live (NOT PLANTED)
//   - subject reverted mid-proof  → something un-planted it   (UN-PLANTED)
//   - subject drifted mid-proof   → the run cannot be attributed
//
// Without them, an ineffective REVOKE (the privilege still reachable via
// PUBLIC or an inherited role, a grantor no-op, or tooling that re-applies
// migrations mid-run) leaves the proof green against a healthy database, and
// the summary blames the proof for a defect that was never live.
//
// A mutation whose apply intentionally leaves its subject untouched — it
// plants a side object that `cleanup` removes, and the subject only anchors
// restore — must declare `applyDoesNotChangeSubject: true` in the catalog.
// Such mutations keep the historical blind spot by explicit, reviewable
// choice rather than by accident.
// ---------------------------------------------------------------------------

/**
 * Judge the subject immediately after `apply`. Returns an error message when
 * the run must stop, or null when the plant is coherent.
 */
export function assessPlantedSubject({
  id,
  description,
  before,
  afterApply,
  applyDoesNotChangeSubject = false,
}) {
  if (applyDoesNotChangeSubject) {
    if (afterApply === before) return null;
    return (
      `mutation ${id} declares applyDoesNotChangeSubject, but applying it changed ` +
      `${description}. The declaration is wrong; remove it so the subject is verified.\n` +
      `  before apply: ${before}\n  after apply:  ${afterApply}`
    );
  }
  if (afterApply !== before) return null;
  return (
    `mutation ${id} is NOT PLANTED: ${description} reads exactly the same before and after ` +
    `apply, so the defect is not live and its proof would run against a healthy database. ` +
    `Common causes: the privilege is still held via PUBLIC or an inherited role, the ` +
    `GRANT/REVOKE was a silent no-op, or concurrent tooling immediately restored the subject. ` +
    `If the apply intentionally leaves the subject untouched (it plants a side object that ` +
    `cleanup removes), declare applyDoesNotChangeSubject: true on the mutation.\n` +
    `  subject snapshot: ${before}`
  );
}

/**
 * Judge the subject after the proof ran, before restore. Returns an error
 * message when the defect was no longer (or differently) planted, or null
 * when the proof demonstrably ran against the planted defect.
 */
export function assessSubjectAfterProof({
  id,
  description,
  before,
  afterApply,
  afterProof,
  applyDoesNotChangeSubject = false,
}) {
  const expected = applyDoesNotChangeSubject ? before : afterApply;
  if (afterProof === expected) return null;
  if (afterProof === before) {
    return (
      `mutation ${id} was UN-PLANTED while its proof ran: ${description} returned to its ` +
      `pre-mutation state before the proof finished, so the proof never had a chance to detect ` +
      `the defect and its verdict is meaningless. Something outside the harness restored the ` +
      `subject mid-run — typically dev-server bootstrap or migration tooling re-applying grants ` +
      `(for example a wholesale "REVOKE ALL; GRANT ..." migration). This is a ` +
      `harness/environment failure, not a missed proof.`
    );
  }
  return (
    `mutation ${id} lost its planted state while its proof ran: ${description} changed to a ` +
    `state matching neither the planted defect nor the original, so the run cannot be ` +
    `attributed to the mutation.\n` +
    `  before apply: ${before}\n  after apply:  ${afterApply}\n  after proof:  ${afterProof}`
  );
}
