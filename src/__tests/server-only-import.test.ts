// Import External Packages
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Import Local Imports
// Import Core Dependencies
// Import Shared Dependencies
// Import Extension Dependencies

// ---------------------------------------------------------------------------
// Playwright loads `proof-harness/playwright` in plain Node, not as a React Server
// Component. `import "server-only"` throws during test *discovery*, so the
// suite never starts and `.proof/traces/` stays empty — no evidence, not bad
// evidence. Vitest mocks `server-only` to `{}`, so importing a guarded module
// here would not reproduce the failure. Scan source instead.
// ---------------------------------------------------------------------------

const PROOF_SRC = "src";
const SERVER_ONLY_IMPORT = /^\s*import\s+["']server-only["']/m;
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(full);
    }
  };
  if (fs.statSync(dir).isDirectory()) walk(dir);
  return out.sort();
}

function scanServerOnlyImports(dir: string): {
  files: string[];
  offenders: string[];
} {
  const files = sourceFiles(dir);
  const offenders = files.filter((file) =>
    SERVER_ONLY_IMPORT.test(fs.readFileSync(file, "utf8")),
  );
  return { files, offenders };
}

function assertNoServerOnlyImports(dir: string) {
  const { files, offenders } = scanServerOnlyImports(dir);
  expect(
    files.length,
    `scan found no source files under ${dir}; an empty scan cannot certify the absence of server-only imports`,
  ).toBeGreaterThan(0);
  expect(
    offenders,
    `Playwright discovery would throw on: ${offenders.join(", ")}`,
  ).toEqual([]);
}

function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-server-only-"));
  fixtures.push(dir);
  return dir;
}

function write(dir: string, relative: string, contents: string) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

describe("proof harness must not import server-only", () => {
  it("holds for every source file under the proof SDK", () => {
    assertNoServerOnlyImports(PROOF_SRC);
  });

  it("goes red when the scanned directory does not exist", () => {
    const missing = path.join(PROOF_SRC, "does-not-exist");
    const { files, offenders } = scanServerOnlyImports(missing);
    expect(files).toEqual([]);
    expect(offenders).toEqual([]);
    expect(() => assertNoServerOnlyImports(missing)).toThrow(
      /scan found no source files/,
    );
  });

  it("goes red when a file in the tree imports server-only", () => {
    const dir = fixtureDir();
    write(dir, "server/helper.ts", "export const ok = true;\n");
    write(
      dir,
      "server/guarded.ts",
      `import ${JSON.stringify("server-only")};\nexport const nope = true;\n`,
    );
    const { files, offenders } = scanServerOnlyImports(dir);
    expect(files).toHaveLength(2);
    expect(offenders).toEqual([path.join(dir, "server/guarded.ts")]);
    expect(() => assertNoServerOnlyImports(dir)).toThrow(
      /Playwright discovery/,
    );
  });

  it("stays silent on a tree that has files and no server-only import", () => {
    const dir = fixtureDir();
    write(
      dir,
      "server/index.ts",
      "// Intentionally does NOT use the server-only package\nexport const seed = {};\n",
    );
    assertNoServerOnlyImports(dir);
  });
});
