import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

import { tableAclSnapshotSql } from "../cli/engines/proof_table_acl.mjs";
const container = process.env.PROOF_ACL_TEST_CONTAINER;
it.skipIf(!container)(
  "restores column privileges and grant options after a mutation and journal recovery",
  async () => {
    const command = "mutate",
      role = "primary",
      code = "authorization",
      assertionStatus = "failed",
      accepted = true;
    const sql = (query: string) => {
      const result = spawnSync(
        "docker",
        [
          "exec",
          "-i",
          container!,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-X",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          query,
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const subject = {
      kind: "tablePrivilege",
      table: "public.acl_fixture",
      role: "proof_acl_reader",
      privilege: "UPDATE",
    };
    sql(
      "DROP TABLE IF EXISTS public.acl_fixture; DROP ROLE IF EXISTS proof_acl_reader; CREATE ROLE proof_acl_reader; GRANT proof_acl_reader TO postgres WITH SET TRUE; CREATE TABLE public.acl_fixture (full_name text, username text, privileged text); INSERT INTO public.acl_fixture VALUES ('Before','owner','secret'); GRANT UPDATE (full_name) ON public.acl_fixture TO proof_acl_reader WITH GRANT OPTION; GRANT UPDATE (username) ON public.acl_fixture TO proof_acl_reader;",
    );
    const before = sql(tableAclSnapshotSql(subject));
    const verify = () => {
      expect(sql(tableAclSnapshotSql(subject))).toBe(before);
      expect(
        sql(
          "SELECT has_column_privilege('proof_acl_reader','public.acl_fixture','full_name','UPDATE WITH GRANT OPTION')",
        ),
      ).toBe("t");
      expect(
        sql(
          "SELECT has_column_privilege('proof_acl_reader','public.acl_fixture','privileged','UPDATE')",
        ),
      ).toBe("f");
      sql(
        "SET ROLE proof_acl_reader; UPDATE public.acl_fixture SET full_name='After'; RESET ROLE;",
      );
    };
    verify();

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
        'export default {mutationCatalog:"controls.mjs",controlSensitivityCatalog:"controls.mjs"};',
      );
      write(
        "supabase/config.toml",
        `project_id = "${container!.replace(/^supabase_db_/, "")}"`,
      );
      write("src/guard.txt", "control allowed");
      write(".proof/schema.json", '{"schemaVersion":1,"tables":[]}');
      const isPrimaryRun = command === "mutate";
      const selector = isPrimaryRun
        ? {
            kind: "authorization",
            target: "acl_fixture",
            operation: "invoke",
          }
        : {
            kind: "tenant_isolation",
            target: "workspace_members",
            operation: "select",
            emittedBy: "assert.tenantIsolation",
          };
      write(
        "controls.mjs",
        `export default [${JSON.stringify({ id: "deny-all", spec: "e2e/proofs/control.proof.ts", finding: "anti-vacuity", breaks: "positive control denied", subject, apply: "GRANT UPDATE ON public.acl_fixture TO proof_acl_reader;", claims: isPrimaryRun ? [selector] : [], controls: isPrimaryRun ? [] : [selector], expectedFailureCode: "tenant_isolation_control" })}];`,
      );
      write(
        "playwright.config.ts",
        `export default {testDir:'./e2e/proofs',testMatch:'**/*.proof.ts',projects:[{name:'proofs'}]};`,
      );
      const spec = `import {test,expect} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('controlled trace fixture',()=>{
 const result = spawnSync('docker',['exec','-i',process.env.PROOF_ACL_TEST_CONTAINER,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',"SET ROLE proof_acl_reader; UPDATE public.acl_fixture SET privileged='breach';"],{encoding:'utf8'}); expect(result.status,result.stderr).toBe(0);
 if(process.env.PROOF_ACL_INTERRUPT==='1') { process.kill(Number(process.env.PROOF_ACL_RUNNER_PID),'SIGKILL'); return; }
 const trace={schemaVersion:2,proofId:'control',specFile:'e2e/proofs/control.proof.ts',timestamp:new Date().toISOString(),durationMs:1,passed:false,mutation:{id:process.env.PROOF_MUTATION_ID,planted:true},steps:[{intent:'control failure',kind:'${selector.kind}',target:'${selector.target}',observation:'denied',durationMs:1,passed:false,error:'[PROOF_FAIL] ${code}: expected owner visibility',assertions:${JSON.stringify([{ ...selector, role, passed: false, status: assertionStatus }])}}]};
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
              kind: selector.kind,
              target: selector.target,
              observation: "allowed",
              durationMs: 1,
              passed: true,
              assertions: [
                {
                  ...selector,
                  role: isPrimaryRun ? "primary" : "control",
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
        `#!/usr/bin/env node\nimport fs from 'node:fs';import {createServer} from 'node:http';if(process.argv[2]==='exec'){console.log('DB_URL=postgres://fixture@127.0.0.1:54322/postgres');process.exit(0);}fs.writeFileSync('server.pid',String(process.pid));createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({protocolVersion:1}));}).listen(Number(process.env.PORT),'127.0.0.1');`,
      );
      fs.chmodSync(path.join(root, "bin/pnpm"), 0o755);
      const run = spawnSync(
        process.execPath,
        [path.resolve("cli/proof-harness.mjs"), command, "--only", "deny-all"],
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
          path.join(
            root,
            isPrimaryRun
              ? ".proof/mutations/summary.json"
              : ".proof/control-sensitivity/summary.json",
          ),
          "utf8",
        ),
      );
      expect(summary.schemaVersion).toBe(1);
      if (isPrimaryRun) {
        expect(summary.mode).toBe("primary-mutation");
        expect(summary.controls).toBeUndefined();
        expect(summary.mutations[0]).toMatchObject({
          detected: accepted,
          controlRejected: false,
        });
        expect(
          fs.existsSync(path.join(root, ".proof/control-sensitivity")),
        ).toBe(false);
      } else {
        expect(summary.mode).toBe("control-sensitivity");
        expect(summary.mutations).toBeUndefined();
        expect(summary.controls[0]).toMatchObject({
          detected: false,
          controlRejected: accepted,
        });
        expect(fs.existsSync(path.join(root, ".proof/mutations"))).toBe(false);
      }
      verify();
      // Kill the real mutation runner after its proof observes the committed plant.
      const cliPath = path.resolve("cli/engines/proof_mutation_check.mjs");
      const interrupted = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `process.env.PROOF_ACL_RUNNER_PID=String(process.pid); process.argv=[process.execPath,${JSON.stringify(cliPath)},"--only","deny-all"]; await import(${JSON.stringify("file://" + cliPath)});`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            PROOF_ACL_INTERRUPT: "1",
            PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
            DEV_SERVER: `http://127.0.0.1:${port}`,
            API_SECRET_KEY: "fixture-secret",
            NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          },
        },
      );
      expect(interrupted.signal, interrupted.stdout + interrupted.stderr).toBe(
        "SIGKILL",
      );
      expect(
        fs.existsSync(path.join(root, ".proof/mutation-recovery.json")),
      ).toBe(true);
      expect(
        sql(
          "SELECT has_table_privilege('proof_acl_reader','public.acl_fixture','UPDATE')",
        ),
      ).toBe("t");
      // SIGKILL bypasses the runner's server cleanup; stop the known fixture process.
      try {
        process.kill(
          Number(fs.readFileSync(path.join(root, "server.pid"), "utf8")),
        );
      } catch {
        /* already exited */
      }
      const recovered = spawnSync(
        process.execPath,
        [path.resolve("cli/proof-harness.mjs"), "mutate", "--recover"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          },
        },
      );
      expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
      verify();
      expect(
        fs.existsSync(path.join(root, ".proof/mutation-recovery.json")),
      ).toBe(false);
    } finally {
      sql("DROP TABLE public.acl_fixture; DROP ROLE proof_acl_reader;");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  40000,
);
