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
      version: "0.1.0-next.4",
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
      version: "0.1.0-next.4",
      filename: "proof-harness-0.1.0-next.4.tgz",
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
      expect(files.some((file) => file.includes(marker)), marker).toBe(false);
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
          'import * as vocabulary from "proof-harness/portable-vocabulary";',
          'if (!shared.TRACE_ARTIFACT_SCHEMA_VERSION) throw new Error("shared export missing");',
          'if (typeof nodeApi.validateMission !== "function") throw new Error("node export missing");',
          'if (typeof serverApi.proofGuard !== "function") throw new Error("server export missing");',
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
  }, 120_000);
});
