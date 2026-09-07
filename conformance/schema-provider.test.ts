import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
const cli = path.resolve("cli/proof-harness.mjs");
const fixture = JSON.parse(
  fs.readFileSync(
    "proof-consumer-fixtures/schema-provider/catalog.json",
    "utf8",
  ),
);
let root: string;
function write(file: string, value: string) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, value);
}
function run(...args: string[]) {
  const p = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: p.status, output: p.stdout + p.stderr };
}
function schema() {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".proof/schema.json"), "utf8"),
  );
}
function git(...args: string[]) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status) throw new Error(r.stderr);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-provider-"));
  write("package.json", '{"type":"module","name":"fixture"}');
  write(
    "proof.config.mjs",
    'export default {schemaProvider:"provider.mjs",roots:{migrations:"sql",actions:[]}};',
  );
  write(
    "sql/001.sql",
    "CREATE TABLE widgets (id uuid); ALTER TABLE widgets ADD COLUMN workspace_id uuid;",
  );
  write(
    "provider.mjs",
    `export default async () => (${JSON.stringify(fixture)});`,
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("uses the provider instead of overwriting its catalog with historical SQL parsing", () => {
  const result = run("parse");
  expect(result.status, result.output).toBe(0);
  expect(schema()).toMatchObject({
    assessed: true,
    tables: [
      {
        name: "widgets",
        columns: ["id", "workspace_id"],
        rls_enabled: true,
        rls_classification: "workspace_scoped",
      },
    ],
    assessment: { protocolVersion: 1, provider: "provider.mjs" },
  });
  const hash = schema().assessment.inputHash;
  write("sql/002.sql", "ALTER TABLE widgets DROP COLUMN workspace_id;");
  expect(run("parse").status).toBe(0);
  expect(schema().assessment.inputHash).not.toBe(hash);
});
it.each([
  null,
  { ...fixture, protocolVersion: 2 },
  { ...fixture, tables: [{ name: "widgets" }] },
  { ...fixture, assessed: false, issues: ["migration failed"] },
])(
  "rejects malformed or incomplete assessment without preserving stale green output",
  (value) => {
    expect(run("parse").status).toBe(0);
    write(
      "provider.mjs",
      `export default async () => (${JSON.stringify(value)});`,
    );
    expect(run("parse").status).not.toBe(0);
    expect(schema()).toMatchObject({ assessed: false, tables: [] });
  },
);
it("runs each tree's own provider against its own migrations during drift", () => {
  write(
    "provider.mjs",
    `export default async ({migrations}) => { const result=${JSON.stringify(fixture)}; if(migrations.some(m=>m.sql.includes('new_column'))) result.tables[0].columns.push('new_column'); return result; };`,
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
    "base with provider",
  );
  write("sql/002.sql", "ALTER TABLE widgets ADD COLUMN new_column text;");
  const result = run("drift", "--base", "HEAD", "--json");
  expect(result.status, result.output).toBe(1);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, ".proof/drift.json"), "utf8"),
  );
  expect(report.assessed, result.output).toBe(true);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "widgets", facets: ["columns_added"] }),
    ]),
  );
});
it("requires explicit bootstrap when the protected base has no provider", () => {
  write(
    "proof.config.mjs",
    'export default {roots:{migrations:"sql",actions:[]}};',
  );
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "old base",
  );
  write(
    "proof.config.mjs",
    'export default {schemaProvider:"provider.mjs",roots:{migrations:"sql",actions:[]}};',
  );
  write(".proof/current-mission.json", '{"expectedChanges":{}}');
  const result = run("drift", "--base", "HEAD");
  expect(result.status).toBe(1);
  expect(result.output).toContain("preparatory base commit");
});

it("rejects migration files added by the provider during assessment", () => {
  write(
    "provider.mjs",
    `import fs from 'node:fs'; import path from 'node:path'; export default async ({rootDir}) => { fs.writeFileSync(path.join(rootDir,'sql/002.sql'),'SELECT 1;'); return ${JSON.stringify(fixture)}; };`,
  );
  const result = run("parse");
  expect(result.status).toBe(1);
  expect(result.output).toContain("inputs changed during assessment");
  expect(schema().assessed).toBe(false);
});

it("detects FORCE RLS changes even when enabled state and policies are unchanged", () => {
  write(
    "provider.mjs",
    `export default async ({migrations}) => { const result=${JSON.stringify(fixture)}; result.tables[0].rls_forced=migrations.some(m=>m.sql.includes('FORCE ROW')); return result; };`,
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
    "base",
  );
  write("sql/002.sql", "ALTER TABLE widgets FORCE ROW LEVEL SECURITY;");
  const result = run("drift", "--base", "HEAD");
  expect(result.status, result.output).toBe(1);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, ".proof/drift.json"), "utf8"),
  );
  expect(report.assessed).toBe(true);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        key: "widgets",
        facets: ["rls_classification_changed"],
      }),
    ]),
  );
});
