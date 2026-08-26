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

describe("@saasist/proof package contents", () => {
  it("packs only package-owned runtime, contracts, and fixtures", () => {
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
      name: "@saasist/proof",
      version: "0.1.0-next.1",
    });
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "COMPATIBILITY.md",
        "PROOF_SDK_CONTRACT.md",
        "cli/saasist-proof.mjs",
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
      path.join(consumer, "node_modules", "@saasist", "proof"),
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
          'import * as shared from "@saasist/proof/shared";',
          'import * as nodeApi from "@saasist/proof/node";',
          'import * as serverApi from "@saasist/proof/server";',
          'import * as vocabulary from "@saasist/proof/portable-vocabulary";',
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
      ["node_modules/@saasist/proof/cli/saasist-proof.mjs", "--help"],
      consumer,
    );
    expect(binOutput).toContain("Usage: saasist-proof");
  }, 120_000);
});
