import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";

const cli = path.resolve("cli/proof-harness.mjs");
let dir: string;
function write(file: string, text: string) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function run(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function json(file: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}
const action = (name: string) =>
  `export const ${name} = createAction({functionName:"${name}"}).use(withProof({verb:"create",object:"widget",invariants:[]}));`;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-cli-hardening-"));
  write("package.json", '{"name":"fixture","private":true,"type":"module"}');
  write(
    "proof.config.mjs",
    'export default {roots:{source:"src",actions:["src/modules"],migrations:"sql"}};',
  );
  write(
    "sql/001.sql",
    "CREATE TABLE widgets (id uuid, workspace_id uuid); ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;",
  );
  write(".proof/current-mission.json", '{"expectedChanges":{}}');
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "baseline",
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

it("scans aliased factories and multiple actions without merging their metadata", () => {
  write(
    "src/modules/widgets/src/actions/create.ts",
    `import {createAction as action} from "factory";\n${action("one").replace("createAction(", "action(")}\n${action("two").replace("createAction(", "action(")}`,
  );
  const result = run("scan");
  expect(result.status, result.output).toBe(0);
  expect(
    json(".proof/capabilities.json").capabilities.map(
      (c: { name: string }) => c.name,
    ),
  ).toEqual(["one", "two"]);
});
it("blocks escaped service clients and unresolved table expressions", () => {
  write(
    "src/modules/widgets/src/actions/create.ts",
    `${action("one")}\nconst db = await createSupabaseServiceClient(); const alias = db; await alias.from(tableName).insert({});`,
  );
  const result = run("scan");
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("capabilities_unassessed");
});
it.each([
  "ALTER TABLE widgets DROP COLUMN workspace_id;",
  "DROP TABLE widgets;",
  "ALTER TABLE widgets DISABLE ROW LEVEL SECURITY;",
  "DROP POLICY p ON widgets;",
])("blocks unsupported final-state SQL: %s", (sql) => {
  write("sql/002.sql", sql);
  expect(run("parse").status).not.toBe(0);
  expect(json(".proof/schema.json").assessed).toBe(false);
});
it.each(["ALL", "DELETE"])(
  "does not exempt public %s policy writes as public read",
  (command) => {
    write(
      "sql/002.sql",
      `CREATE POLICY p ON widgets FOR ${command} TO authenticated USING (true);`,
    );
    const result = run("parse");
    expect(result.status, result.output).toBe(0);
    expect(json(".proof/schema.json").tables[0].rls_classification).not.toBe(
      "public_read",
    );
  },
);
it("rebuilds a base without template scripts and detects an untracked action", () => {
  write("src/modules/widgets/src/actions/new.ts", action("unexpected"));
  const result = run("drift", "--base", "HEAD", "--json");
  expect(result.status, result.output).toBe(1);
  const report = json(".proof/drift.json");
  expect(report.assessed, result.output).toBe(true);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        area: "action",
        key: "widgets:unexpected",
        change: "added",
      }),
    ]),
  );
});
it("detects untracked migration tables and lockfiles", () => {
  write("sql/002.sql", "CREATE TABLE unexpected (id uuid);");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const result = run("drift", "--base", "HEAD", "--json");
  expect(result.status, result.output).toBe(1);
  const report = json(".proof/drift.json");
  expect(report.assessed, result.output).toBe(true);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ area: "table", key: "unexpected" }),
      expect.objectContaining({ area: "lockfile" }),
    ]),
  );
});

it("rejects corrupt, duplicate, stale and mutation-only evidence through verify and coverage", async () => {
  const { sourceHash } = await import("proof-harness/node");
  const crypto = await import("node:crypto");
  write(
    ".proof/current-mission.json",
    JSON.stringify({
      schemaVersion: 1,
      missionId: "widgets",
      missionTitle: "Widget proof",
      createdAt: "2026-09-07T00:00:00.000Z",
      requirements: {
        capabilities_must_exist: [],
        schema_must_contain: [],
        trace_must_prove: [],
      },
    }),
  );
  write(
    ".proof/schema.json",
    JSON.stringify({
      schemaVersion: 1,
      tables: [
        {
          name: "widgets",
          columns: ["id"],
          rls_classification: "workspace_scoped",
          policies: [],
        },
      ],
    }),
  );
  write(
    ".proof/capabilities.json",
    '{"schemaVersion":1,"capabilities":[],"unclassified":[]}',
  );
  write(
    ".proof/coverage-policy.json",
    '{"schemaVersion":1,"acceptedGaps":[],"reviewedUnclassified":[]}',
  );
  write("e2e/proofs/widgets.proof.ts", "// current proof");
  const trace = {
    schemaVersion: 2,
    proofId: "widgets",
    missionId: "widgets",
    timestamp: "2026-09-07T00:00:00.000Z",
    durationMs: 1,
    passed: true,
    specFile: "e2e/proofs/widgets.proof.ts",
    specHash: crypto
      .createHash("sha256")
      .update("// current proof")
      .digest("hex")
      .slice(0, 12),
    commit: git("rev-parse", "HEAD"),
    sourceHash: sourceHash(dir),
    steps: [
      {
        kind: "tenant_isolation",
        target: "widgets",
        intent: "observe isolation",
        observation: "denied",
        passed: true,
        durationMs: 1,
        assertions: [
          {
            kind: "tenant_isolation",
            target: "widgets",
            passed: true,
            operation: "select",
            emittedBy: "assert.tenantIsolation",
          },
        ],
      },
    ],
  };
  const commands = [
    ["verify", "--no-run"],
    ["coverage", "--strict"],
  ];
  write(".proof/traces/widgets.json", JSON.stringify(trace));
  for (const command of commands) {
    const result = run(...command);
    expect(result.status, result.output).toBe(0);
  }
  expect(json(".proof/traces/widgets.json").proofId).toBe("widgets");
  expect(json(".proof/traces/missions/widgets.json").missionId).toBe("widgets");
  write(".proof/traces/broken.json", "{broken");
  for (const command of commands)
    expect(run(...command).output).toContain("invalid_json");
  fs.unlinkSync(path.join(dir, ".proof/traces/broken.json"));
  write(".proof/traces/duplicate.json", JSON.stringify(trace));
  for (const command of commands)
    expect(run(...command).output).toContain("duplicate_proof_id");
  fs.unlinkSync(path.join(dir, ".proof/traces/duplicate.json"));
  write("src/untracked.ts", "// changed input");
  for (const command of commands)
    expect(run(...command).output).toContain("stale_trace");
  fs.unlinkSync(path.join(dir, "src/untracked.ts"));
  write(
    ".proof/traces/widgets.json",
    JSON.stringify({ ...trace, mutation: { id: "mutant", planted: true } }),
  );
  for (const command of commands) expect(run(...command).status).toBe(1);
});

it("recovers a journaled source mutation through the CLI", () => {
  write("supabase/config.toml", 'project_id = "fixture"');
  write("src/guard.ts", "guard removed");
  write(
    ".proof/mutation-recovery.json",
    JSON.stringify({
      id: "guard",
      container: "supabase_db_fixture",
      subject: { kind: "sourceFile", file: "src/guard.ts" },
      snapshot: "guard enabled",
    }),
  );
  write(
    "bin/pnpm",
    `#!${process.execPath}\nconsole.log('DB_URL="postgresql://postgres:fixture@127.0.0.1:54322/postgres"');`,
  );
  fs.chmodSync(path.join(dir, "bin/pnpm"), 0o755);
  const result = spawnSync(process.execPath, [cli, "mutate", "--recover"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(path.join(dir, "src/guard.ts"), "utf8")).toBe(
    "guard enabled",
  );
  expect(fs.existsSync(path.join(dir, ".proof/mutation-recovery.json"))).toBe(
    false,
  );
});
it("restores complete policy state transactionally from a recovery journal", () => {
  const snapshot = JSON.stringify({
    using: "(workspace_id = auth.uid())",
    check: null,
    command: "w",
    permissive: false,
    roles: ['"team-role"'],
  });
  write("supabase/config.toml", 'project_id = "fixture"');
  write(
    ".proof/mutation-recovery.json",
    JSON.stringify({
      id: "policy",
      container: "supabase_db_fixture",
      subject: { kind: "policy", name: "restricted", table: "public.widgets" },
      snapshot,
    }),
  );
  write(
    "bin/pnpm",
    `#!${process.execPath}\nconsole.log('DB_URL="postgresql://postgres:fixture@127.0.0.1:54322/postgres"');`,
  );
  write(
    "bin/docker",
    `#!${process.execPath}\nimport fs from "node:fs"; const args = process.argv.slice(2); if(args.includes("-c")) console.log(${JSON.stringify(snapshot)}); else fs.writeFileSync("restore-call.json",JSON.stringify({args,sql:fs.readFileSync(0,"utf8")}));`,
  );
  for (const name of ["pnpm", "docker"])
    fs.chmodSync(path.join(dir, "bin", name), 0o755);
  const result = spawnSync(process.execPath, [cli, "mutate", "--recover"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const restore = json("restore-call.json");
  expect(restore.args).toEqual(
    expect.arrayContaining([
      "--single-transaction",
      "-f",
      "-",
      "ON_ERROR_STOP=1",
    ]),
  );
  expect(restore.sql).toContain(
    'AS RESTRICTIVE FOR UPDATE TO "team-role" USING ((workspace_id = auth.uid()))',
  );
  expect(fs.existsSync(path.join(dir, ".proof/mutation-recovery.json"))).toBe(
    false,
  );
});

it("refuses unknown JSON and repository aliases before trace cleanup", () => {
  write("output/keep.json", '{"customerData":"keep"}');
  const engine = path.resolve(path.dirname(cli), "engines/proof_verify.mjs");
  const clear = (directory: string) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {clearTraceArtifacts} from ${JSON.stringify(engine)}; clearTraceArtifacts(${JSON.stringify(directory)});`,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  expect(clear("output").status).not.toBe(0);
  expect(json("output/keep.json")).toEqual({ customerData: "keep" });
  fs.symlinkSync(dir, path.join(dir, "root-alias"), "dir");
  expect(clear("root-alias").stderr).toContain("unsafe_artifact_directory");
  expect(clear("/").stderr).toContain("unsafe_artifact_directory");
});

it("keeps workspace coverage when scope is supplied by an exported wrapper", () => {
  write(
    "src/modules/widgets/src/actions/create.ts",
    `const pipeline = createAction({functionName:"wrapped"}); export async function wrapped(workspaceId: string) { return pipeline.run({workspaceId}); }`,
  );
  const result = run("scan");
  expect(result.status, result.output).toBe(0);
  expect(
    json(".proof/capabilities.json").capabilities[0].acceptsWorkspaceId,
  ).toBe(true);
});
it("blocks a mutation query with an unresolved client privilege", () => {
  write(
    "src/modules/widgets/src/actions/create.ts",
    `${action("one")} await importedClient.from("widgets").update({name:"changed"});`,
  );
  const result = run("scan");
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("privilege cannot be resolved");
});
