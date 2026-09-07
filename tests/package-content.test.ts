import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

interface PackResult {
  filename: string;
  name: string;
  version: string;
  files: Array<{ path: string }>;
}

const ROOT = process.cwd();
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function run(command: string, args: string[], cwd = ROOT): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function readTextTree(directory: string): string {
  const contents: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(readTextTree(target));
    } else if (entry.isFile()) {
      contents.push(fs.readFileSync(target, "utf8"));
    }
  }
  return contents.join("\n");
}

describe("proof-harness package contents", () => {
  it("packs only package-owned runtime, contracts, and fixtures", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "proof-harness",
      version: "0.1.0-next.10",
      license: "Apache-2.0",
      repository: {
        type: "git",
        url: "git+https://github.com/TiKa-Nexus/proof-harness.git",
      },
      homepage: "https://github.com/TiKa-Nexus/proof-harness#readme",
      bugs: {
        url: "https://github.com/TiKa-Nexus/proof-harness/issues",
      },
      bin: {
        "proof-harness": "./cli/proof-harness.mjs",
      },
    });

    const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "proof-pack-"));
    temporaryDirectories.push(packDirectory);
    const [packed] = JSON.parse(
      run("npm", [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        packDirectory,
      ]),
    ) as PackResult[];
    const files = packed.files.map((entry) => entry.path);

    expect(packed).toMatchObject({
      name: "proof-harness",
      version: "0.1.0-next.10",
      filename: "proof-harness-0.1.0-next.10.tgz",
    });
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "LICENSE",
        "README.md",
        "COMPATIBILITY.md",
        "PROOF_SDK_CONTRACT.md",
        "cli/proof-harness.mjs",
        "cli/config.mjs",
        "dist/shared.js",
        "dist/shared.d.ts",
        "dist/node.js",
        "dist/node.d.ts",
        "dist/playwright.js",
        "dist/playwright.d.ts",
        "dist/server.js",
        "dist/server.d.ts",
        "dist/portable-vocabulary.js",
        "dist/portable-vocabulary.d.ts",
        "proof-consumer-fixtures/corpus.json",
      ]),
    );
    expect(
      files.every(
        (file) =>
          file === "package.json" ||
          file === "LICENSE" ||
          file === "README.md" ||
          file === "COMPATIBILITY.md" ||
          file === "PROOF_SDK_CONTRACT.md" ||
          file.startsWith("cli/") ||
          file.startsWith("dist/") ||
          file.startsWith("proof-consumer-fixtures/"),
      ),
    ).toBe(true);

    const forbidden = [
      "action-registry.generated",
      "supabase/seed.sql",
      "e2e/proofs/",
      ".proof/",
      "mutation-policy.json",
      "current-mission",
    ];
    for (const marker of forbidden) {
      expect(
        files.some((file) => file.includes(marker)),
        marker,
      ).toBe(false);
    }

    const consumer = fs.mkdtempSync(
      path.join(os.tmpdir(), "proof-consumer-install-"),
    );
    temporaryDirectories.push(consumer);
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      '{"name":"proof-pack-consumer","private":true,"type":"module"}\n',
    );
    const tarball = path.join(packDirectory, packed.filename);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        tarball,
        "next@16.3.0",
        "react@19.2.1",
        "react-dom@19.2.1",
        "@supabase/supabase-js@2.108.2",
        "@playwright/test@1.57.0",
      ],
      consumer,
    );
    const installedPackageText = readTextTree(
      path.join(consumer, "node_modules", "proof-harness"),
    );
    for (const credential of [
      "dev-admin@example.com",
      "dev-user@example.com",
      "DevOnly123!",
      "DevUser123!",
    ]) {
      expect(installedPackageText).not.toContain(credential);
    }
    const importOutput = run(
      "node",
      [
        "--input-type=module",
        "--eval",
        [
          'import * as shared from "proof-harness/shared";',
          'import * as nodeApi from "proof-harness/node";',
          'import * as serverApi from "proof-harness/server";',
          'import * as playwrightApi from "proof-harness/playwright";',
          'if (typeof playwrightApi.trace.proof !== "function") throw new Error("trace export missing");',
          'import * as vocabulary from "proof-harness/portable-vocabulary";',
          'if (!shared.TRACE_ARTIFACT_SCHEMA_VERSION) throw new Error("shared export missing");',
          'if (typeof nodeApi.validateMission !== "function") throw new Error("node export missing");',
          'for (const name of ["withLocalPostgres", "readPostgresCatalog", "rollbackInsertControl"]) if (typeof nodeApi[name] !== "function") throw new Error("PostgreSQL export missing: " + name);',
          'if (typeof serverApi.proofGuard !== "function" || typeof serverApi.authenticationRedirectResponse !== "function") throw new Error("server export missing");',
          'if (typeof playwrightApi.actAsUser.invokeAnonymousAction !== "function" || typeof shared.isActionAuthenticationRefusal !== "function") throw new Error("anonymous action API missing");',
          'if (!vocabulary.ACTION_CHANGE_KINDS) throw new Error("vocabulary export missing");',
          'console.log("consumer-import-ok server-import-ok");',
        ].join(""),
      ],
      consumer,
    );
    expect(importOutput).toContain("consumer-import-ok");
    expect(importOutput).toContain("server-import-ok");

    const binOutput = run(
      "node",
      ["node_modules/proof-harness/cli/proof-harness.mjs", "--help"],
      consumer,
    );
    expect(binOutput).toContain("Usage: proof-harness");
    expect(
      run(
        "node",
        [
          "node_modules/proof-harness/cli/proof-harness.mjs",
          "controls",
          "--help",
        ],
        consumer,
      ),
    ).toContain("controlSensitivityCatalog");
    fs.writeFileSync(
      path.join(consumer, "proof.config.mjs"),
      'export default {roots:{actions:["modules"],migrations:"sql"}};',
    );
    const actionsDir = path.join(consumer, "modules/widgets/src/actions");
    fs.mkdirSync(actionsDir, { recursive: true });
    fs.mkdirSync(path.join(consumer, "sql"));
    fs.writeFileSync(
      path.join(actionsDir, "create.ts"),
      'export const create = createAction({functionName:"createWidget"});',
    );
    const scan = run(
      "node",
      ["node_modules/proof-harness/cli/proof-harness.mjs", "scan"],
      consumer,
    );
    expect(scan).toContain("1 capabilities, 0 unclassified");
    expect(
      run(
        "node",
        ["node_modules/proof-harness/cli/proof-harness.mjs", "parse"],
        consumer,
      ),
    ).toContain("schema");
    fs.writeFileSync(
      path.join(actionsDir, "clients.ts"),
      `
      import {createSupabaseRLSClient as rls, createSupabaseServiceClient as service} from 'consumer-factories';
      export const remove = createAction({functionName:'removeUser'});
      const member = rls(); await member.from('users').update({name:'x'});
      const admin = service(); await admin.auth.admin.deleteUser('id');
    `,
    );
    expect(
      run(
        "node",
        ["node_modules/proof-harness/cli/proof-harness.mjs", "scan"],
        consumer,
      ),
    ).toContain("2 capabilities, 0 unclassified");
    const scanned = JSON.parse(
      fs.readFileSync(path.join(consumer, ".proof/capabilities.json"), "utf8"),
    );
    expect(
      scanned.capabilities.find(
        (c: { name: string }) => c.name === "removeUser",
      ),
    ).toMatchObject({
      serviceRoleMutations: [],
      serviceRoleAuthOperations: ["deleteUser"],
    });

    // Exercise the provider through the installed CLI, not source-tree imports.
    fs.writeFileSync(
      path.join(consumer, "proof.config.mjs"),
      'export default {schemaProvider:"provider.mjs",roots:{actions:["modules"],migrations:"sql"}};',
    );
    fs.writeFileSync(
      path.join(consumer, "provider.mjs"),
      'export default async ({withLocalPostgres,readPostgresCatalog}) => { if(typeof withLocalPostgres!=="function" || typeof readPostgresCatalog!=="function") throw new Error("provider helpers missing"); return ' +
        fs.readFileSync(
          path.join(
            ROOT,
            "proof-consumer-fixtures/schema-provider/catalog.json",
          ),
          "utf8",
        ) +
        "; };",
    );
    expect(
      run(
        "node",
        ["node_modules/proof-harness/cli/proof-harness.mjs", "parse"],
        consumer,
      ),
    ).toContain("catalog provider assessed 1 tables");
  }, 120_000);
});
