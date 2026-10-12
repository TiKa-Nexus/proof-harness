import { test } from "@playwright/test";

/** Diagnostic Playwright steps; no additional assertions or trace evidence. */
export async function fixtureTiming<T>(
  phase: "setup" | "cleanup",
  run: () => Promise<T>,
): Promise<T> {
  if (!process.env.PROOF_EXECUTION_REPORT) return run();
  try {
    test.info();
  } catch {
    return run();
  }
  return test.step(`proof fixture ${phase}`, run);
}
