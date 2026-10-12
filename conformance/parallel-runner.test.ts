import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { expect, it } from "vitest";

it("runs isolated spec baselines and mutations, independently aggregates them and rejects damaged evidence", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "proof-parallel-"));
  const root = path.join(base, "consumer");
  fs.mkdirSync(root);
  const cli =
    process.env.PROOF_TEST_CLI ?? path.resolve("cli/proof-harness.mjs");
  const sdk = process.env.PROOF_TEST_SDK ?? path.resolve("dist/playwright.js");
  const modules =
    process.env.PROOF_TEST_NODE_MODULES ?? path.resolve("node_modules");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const env: Record<string, string | undefined> = {
    ...process.env,
    PROOF_RUN_ID: "conformance",
    GITHUB_RUN_ID: "",
    API_SECRET_KEY: "fixture-secret",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
  };
  delete env.GITHUB_RUN_ID;
  function run(cwd: string, args: string[], ok = true) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 40000,
    });
    if (ok) expect(result.status, result.stdout + result.stderr).toBe(0);
    else expect(result.status, result.stdout + result.stderr).not.toBe(0);
    return result;
  }
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  const ports: number[] = [];
  for (let i = 0; i < 2; i++) {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    ports.push((listener.address() as { port: number }).port);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  try {
    write(".gitignore", "node_modules/\n.proof/parallel/\ntest-results/\n");
    write("package.json", '{"type":"module"}');
    write("pnpm-lock.yaml", "fixture: true\n");
    fs.symlinkSync(modules, path.join(root, "node_modules"), "dir");
    write(
      "proof.config.mjs",
      `export default {mutationCatalog:'mutations.mjs',controlSensitivityCatalog:'controls.mjs',parallel:{postChecks:[[${JSON.stringify(process.execPath)},'-e',"if(require('fs').readFileSync('guard.txt','utf8')!=='allowed')process.exit(1)"]]}};`,
    );
    write("controls.mjs", "export default [];");
    write("supabase/config.toml", 'project_id = "fixture"');
    write("guard.txt", "allowed");
    write(".proof/schema.json", '{"schemaVersion":1,"tables":[]}');
    write(
      ".proof/capabilities.json",
      '{"schemaVersion":1,"capabilities":[],"unclassified":[]}',
    );
    write(
      ".proof/mutation-policy.json",
      '{"schemaVersion":1,"acceptedClaims":[]}',
    );
    write(
      "playwright.config.ts",
      `export default {testDir:'./e2e/proofs',testMatch:'**/*.proof.ts',projects:[{name:'proofs'}]};`,
    );
    write(
      "mutations.mjs",
      `export default [{id:'guard',spec:'e2e/proofs/a.proof.ts',subject:{kind:'sourceFile',file:'guard.txt',search:'allowed',replacement:'denied'},claims:[{kind:'authorization',target:'guard',operation:'invoke'}]}];`,
    );
    write(
      "e2e/proofs/a.proof.ts",
      `import {test} from '@playwright/test';import fs from 'node:fs';import {trace,recordAssertion} from ${JSON.stringify(sdk)};test('guard',async()=>{await trace.proof('guard',async(t)=>{await t.step({kind:'authorization',target:'guard',intent:'guard'},async()=>{const passed=fs.readFileSync('guard.txt','utf8')==='allowed';recordAssertion({kind:'authorization',target:'guard',operation:'invoke',passed});if(!passed)throw new Error('[PROOF_FAIL] authorization: denied');});});});`,
    );
    write(
      "e2e/proofs/nested/b.proof.ts",
      `import {test} from '@playwright/test';import {trace} from ${JSON.stringify(sdk)};test('no mutations',async()=>{await trace.proof('simple',async()=>{});});`,
    );
    write(
      "bin/pnpm",
      `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';import {createServer} from 'node:http';if(process.argv[2]==='exec'&&process.argv[3]==='supabase'){console.log('DB_URL=postgres://fixture@127.0.0.1:54322/postgres');}else if(process.argv[2]==='exec'){const r=spawnSync(process.execPath,[${JSON.stringify(path.join(modules, "@playwright/test/cli.js"))},...process.argv.slice(4)],{stdio:'inherit',env:process.env});process.exit(r.status??1);}else{createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({protocolVersion:1}));}).listen(Number(process.env.PORT),'127.0.0.1');}`,
    );
    fs.chmodSync(path.join(root, "bin/pnpm"), 0o755);
    git(["init", "-q"]);
    git(["config", "user.email", "fixture@example.test"]);
    git(["config", "user.name", "Fixture"]);
    git(["remote", "add", "origin", "https://example.test/fixture.git"]);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    run(root, [
      "plan",
      "--shards",
      "2",
      "--controls-config",
      "proof.config.mjs",
    ]);
    write(".proof/traces/stale.json", "{invalid old evidence");
    const roots = [root, path.join(base, "second")];
    fs.cpSync(root, roots[1], { recursive: true, verbatimSymlinks: true });
    await Promise.all(
      roots.map(async (cwd, i) => {
        const laneEnv = {
          ...env,
          DEV_SERVER: `http://127.0.0.1:${ports[i]}`,
          PATH: path.join(cwd, "bin") + path.delimiter + process.env.PATH,
        };
        for (const stage of ["verify", "mutate", "controls", "finalize"]) {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                cli,
                stage,
                "--plan",
                ".proof/parallel/plan.json",
                "--shard",
                String(i),
              ],
              { cwd, env: laneEnv },
            );
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk.toString()));
            child.stderr.on("data", (chunk) => (output += chunk.toString()));
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(output)),
            );
          });
        }
      }),
    );
    fs.cpSync(
      path.join(roots[1], ".proof/parallel/shard-1"),
      path.join(root, ".proof/parallel/shard-1"),
      { recursive: true },
    );
    const aggregate = [
      "aggregate",
      "--plan",
      ".proof/parallel/plan.json",
      "--inputs",
      ".proof/parallel",
    ];
    run(root, aggregate);
    const acceptanceDir = fs
      .readdirSync(path.join(root, ".proof/parallel"))
      .find((n) => n.startsWith("aggregate-"))!;
    const acceptance = JSON.parse(
      fs.readFileSync(
        path.join(root, ".proof/parallel", acceptanceDir, "acceptance.json"),
        "utf8",
      ),
    );
    expect(acceptance).toMatchObject({
      passed: true,
      tests: 2,
      mutations: 1,
      controls: 0,
      claims: 1,
    });
    // Integrity failures must never become a partial release acceptance.
    const recordFile = path.join(root, ".proof/parallel/shard-0/mutate.json");
    const saved = fs.readFileSync(recordFile, "utf8");
    const original = JSON.parse(saved);
    for (const patch of [
      { passed: false },
      { identity: { ...original.identity, attempt: "999" } },
      { environmentId: "other" },
      { baselineId: "other" },
    ]) {
      fs.writeFileSync(recordFile, JSON.stringify({ ...original, ...patch }));
      run(root, aggregate, false);
    }
    fs.writeFileSync(recordFile, saved);
    const traceDir = path.join(root, ".proof/parallel/shard-1/traces");
    const traceFile = path.join(
      traceDir,
      fs.readdirSync(traceDir).find((n) => n.endsWith(".json"))!,
    );
    fs.unlinkSync(traceFile);
    run(root, aggregate, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}, 120000);
