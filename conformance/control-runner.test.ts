import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  ["control", "tenant_isolation_control", true],
  ["primary", "tenant_isolation_control", false],
  ["control", "tenant_isolation_setup", false],
] as const)(
  "executes and restores a control-sensitivity plant: %s / %s",
  async (role, code, accepted) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-control-run-"));
    const write = (file: string, text: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    try {
      write("package.json", '{"type":"module"}');
      fs.symlinkSync(
        path.resolve("node_modules"),
        path.join(root, "node_modules"),
        "dir",
      );
      write(
        "proof.config.mjs",
        'export default {controlSensitivityCatalog:"controls.mjs"};',
      );
      write("supabase/config.toml", 'project_id = "fixture"');
      write("src/guard.txt", "control allowed");
      const selector = {
        kind: "tenant_isolation",
        target: "workspace_members",
        operation: "select",
        emittedBy: "assert.tenantIsolation",
      };
      write(
        "controls.mjs",
        `export default [${JSON.stringify({ id: "deny-all", spec: "e2e/proofs/control.proof.ts", finding: "anti-vacuity", breaks: "positive control denied", subject: { kind: "sourceFile", file: "src/guard.txt", search: "control allowed", replacement: "control denied" }, claims: [], controls: [selector], expectedFailureCode: "tenant_isolation_control" })}];`,
      );
      write(
        "playwright.config.ts",
        `export default {testDir:'./e2e/proofs',testMatch:'**/*.proof.ts',projects:[{name:'proofs'}]};`,
      );
      const spec = `import {test,expect} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';
test('controlled trace fixture',()=>{
 expect(fs.readFileSync('src/guard.txt','utf8')).toBe('control denied');
 const trace={schemaVersion:2,proofId:'control',specFile:'e2e/proofs/control.proof.ts',timestamp:new Date().toISOString(),durationMs:1,passed:false,mutation:{id:process.env.PROOF_MUTATION_ID,planted:true},steps:[{intent:'control failure',kind:'tenant_isolation',target:'workspace_members',observation:'denied',durationMs:1,passed:false,error:'[PROOF_FAIL] ${code}: expected owner visibility',assertions:[${JSON.stringify({ ...selector, role, passed: false, status: "failed" })}]}]};
 fs.mkdirSync(process.env.PROOF_TRACES_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.PROOF_TRACES_DIR,'control.json'),JSON.stringify(trace));
 throw new Error('[PROOF_FAIL] ${code}: expected owner visibility');
});`;
      write("e2e/proofs/control.proof.ts", spec);
      write(
        ".proof/traces/control.json",
        JSON.stringify({
          schemaVersion: 2,
          proofId: "control",
          specFile: "e2e/proofs/control.proof.ts",
          specHash: crypto
            .createHash("sha256")
            .update(spec)
            .digest("hex")
            .slice(0, 12),
          timestamp: new Date().toISOString(),
          durationMs: 1,
          passed: true,
          steps: [
            {
              intent: "owner can read",
              kind: "tenant_isolation",
              target: "workspace_members",
              observation: "allowed",
              durationMs: 1,
              passed: true,
              assertions: [
                {
                  ...selector,
                  role: "control",
                  passed: true,
                  status: "passed",
                },
              ],
            },
          ],
        }),
      );
      // A tiny fixture server replaces consumer dev bootstrap; no product or DB
      // state is involved. The real runner and Playwright child execute unchanged.
      write(
        "bin/pnpm",
        `#!/usr/bin/env node\nimport {createServer} from 'node:http';if(process.argv[2]==='exec'){console.log('DB_URL=postgres://fixture@127.0.0.1:54322/postgres');process.exit(0);}createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({protocolVersion:1}));}).listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      fs.chmodSync(path.join(root, "bin/pnpm"), 0o755);
      const run = spawnSync(
        process.execPath,
        [
          path.resolve("cli/proof-harness.mjs"),
          "controls",
          "--only",
          "deny-all",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
            DEV_SERVER: `http://127.0.0.1:${port}`,
            API_SECRET_KEY: "fixture-secret",
            NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          },
        },
      );
      expect(run.status, run.stdout + run.stderr).toBe(accepted ? 0 : 1);
      expect(fs.readFileSync(path.join(root, "src/guard.txt"), "utf8")).toBe(
        "control allowed",
      );
      expect(
        fs.existsSync(path.join(root, ".proof/mutation-recovery.json")),
      ).toBe(false);
      const summary = JSON.parse(
        fs.readFileSync(
          path.join(root, ".proof/control-sensitivity/summary.json"),
          "utf8",
        ),
      );
      expect(summary.schemaVersion).toBe(1);
      expect(summary.mode).toBe("control-sensitivity");
      expect(summary.mutations).toBeUndefined();
      expect(summary.controls[0]).toMatchObject({
        detected: false,
        controlRejected: accepted,
      });
      expect(fs.existsSync(path.join(root, ".proof/mutations"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  40000,
);
