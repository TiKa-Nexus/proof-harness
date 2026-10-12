import fs from "node:fs";
import path from "node:path";

/** Sidecar only: trace, mission and health contracts remain unchanged. */
export default class ProofExecutionReporter {
  onBegin(_config, suite) {
    this.started = performance.now();
    this.report = {
      schemaVersion: 1,
      token: process.env.PROOF_EXECUTION_TOKEN ?? null,
      tests: suite.allTests().map((test) => ({
        id: `${test.parent.project().name}:${test.id}:${test.repeatEachIndex}`,
        spec: path
          .relative(process.cwd(), test.location.file)
          .split(path.sep)
          .join("/"),
        title: test.titlePath(),
        expectedStatus: test.expectedStatus,
        attempts: [],
        fixtureSpans: [],
      })),
      errors: [],
    };
  }
  onStepEnd(test, result, step) {
    if (!["proof fixture setup", "proof fixture cleanup"].includes(step.title))
      return;
    const id = `${test.parent.project().name}:${test.id}:${test.repeatEachIndex}`;
    this.report.tests
      .find((t) => t.id === id)
      .fixtureSpans.push({
        phase: step.title,
        retry: result.retry,
        durationMs: step.duration,
        failed: Boolean(step.error),
      });
  }
  onTestEnd(test, result) {
    const id = `${test.parent.project().name}:${test.id}:${test.repeatEachIndex}`;
    this.report.tests
      .find((t) => t.id === id)
      .attempts.push({
        retry: result.retry,
        status: result.status,
        durationMs: result.duration,
        errors: result.errors.map((e) => e.message ?? String(e)),
      });
  }
  onError(error) {
    this.report?.errors.push(error.message ?? String(error));
  }
  onEnd(result) {
    if (!this.report || !process.env.PROOF_EXECUTION_REPORT) return;
    this.report.status = result.status;
    this.report.durationMs = performance.now() - this.started;
    fs.mkdirSync(path.dirname(process.env.PROOF_EXECUTION_REPORT), {
      recursive: true,
    });
    fs.writeFileSync(
      process.env.PROOF_EXECUTION_REPORT,
      JSON.stringify(this.report, null, 2) + "\n",
      { flag: "wx" },
    );
  }
}
