const assertionHelpers = new Set([
  "assert.tenantIsolation",
  "assert.authorization",
  "assert.actionSucceeds",
  "assert.httpResponse",
]);
const helpers = new Set(["assert.tenantIsolation", "assert.authorization"]);
const primary = (a) =>
  a.role === undefined ||
  a.role === null ||
  ["primary", "negative"].includes(a.role);
const control = (a) => ["control", "positive_control"].includes(a.role);
const decisive = (a) => a.status !== "incomplete" && a.status !== "skipped";
const matches = (a, s) =>
  a.kind === s.kind &&
  a.target === s.target &&
  a.operation === s.operation &&
  (!s.emittedBy || a.emittedBy === s.emittedBy);

export function validateControlBaseline(mutation, traces) {
  if (
    !Array.isArray(mutation.claims) ||
    mutation.claims.length ||
    !Array.isArray(mutation.controls) ||
    !mutation.controls.length ||
    mutation.expectedFailureCode !== "tenant_isolation_control"
  )
    throw new Error(
      `[PROOF_FAIL] control_contract: ${mutation.id} requires claims: [], nonempty controls, and expectedFailureCode: tenant_isolation_control`,
    );
  for (const selector of mutation.controls) {
    if (
      selector.kind !== "tenant_isolation" ||
      selector.operation !== "select" ||
      typeof selector.target !== "string" ||
      !selector.target ||
      !helpers.has(selector.emittedBy)
    )
      throw new Error(
        `[PROOF_FAIL] control_contract: ${mutation.id} has an unsupported control selector`,
      );
    const exists = traces.some(
      (t) =>
        t.specFile === mutation.spec &&
        t.passed === true &&
        !t.mutation &&
        t.steps.some(
          (step) =>
            step.passed === true &&
            (step.assertions ?? []).some(
              (a) =>
                a.passed === true &&
                decisive(a) &&
                control(a) &&
                matches(a, selector),
            ),
        ),
    );
    if (!exists)
      throw new Error(
        `[PROOF_FAIL] control_baseline_missing: ${mutation.id} has no fresh passing package-origin control for ${selector.target}`,
      );
  }
  return mutation.controls;
}

/** Control failures cannot satisfy primary claim detection, even for the same key. */
export function assertionSelectorsTurnedRed(
  traces,
  selectors,
  role,
  expectedFailureCode,
) {
  if (!selectors.length) return false;
  return selectors.every((selector) =>
    traces.some(
      (t) =>
        t.passed === false &&
        t.steps.some(
          (step) =>
            step.passed === false &&
            (!expectedFailureCode ||
              step.error?.startsWith(`[PROOF_FAIL] ${expectedFailureCode}:`)) &&
            (step.assertions ?? []).some(
              (a) =>
                a.passed === false &&
                decisive(a) &&
                (role === "control" ? control(a) : primary(a)) &&
                assertionHelpers.has(a.emittedBy) &&
                matches(a, selector),
            ),
        ),
    ),
  );
}
