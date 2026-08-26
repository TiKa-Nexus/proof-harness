#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProofConfig } from "./config.mjs";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINES = {
  scan: "scan_proof_capabilities.mjs",
  parse: "parse_proof_schema.mjs",
  registry: "generate_proof_action_registry.mjs",
  verify: "proof_verify.mjs",
  coverage: "proof_coverage.mjs",
  drift: "proof_drift.mjs",
  modules: "scan_module_meta.mjs",
  "modules-check": "proof_module_check.mjs",
  mutate: "proof_mutation_check.mjs",
};

function printHelp() {
  console.log(`Usage: saasist-proof [--config <path>] <command> [flags]

Commands:
  scan, parse, registry, build, verify, coverage, inventory, drift,
  modules, modules-check, mutate

Repository paths and the protected mutation catalog are read from
proof.config.mjs. Missing config falls back to the SaaSist template layout.`);
}

function runEngine(command, args, config) {
  const engine = ENGINES[command];
  if (!engine) throw new Error(`unknown proof command: ${command}`);
  const result = spawnSync(
    process.execPath,
    [path.join(CLI_DIR, "engines", engine), ...args],
    {
      cwd: config.rootDir,
      env: {
        ...process.env,
        ...(config.configPath
          ? { SAASIST_PROOF_CONFIG: config.configPath }
          : {}),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  const configIndex = args.indexOf("--config");
  let configPath;
  if (configIndex >= 0) {
    configPath = args[configIndex + 1];
    if (!configPath) throw new Error("--config requires a path");
    args.splice(configIndex, 2);
  }

  const command = args.shift();
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  const config = await loadProofConfig({ configPath });
  if (command === "build") {
    for (const [step, stepArgs] of [
      ["scan", []],
      ["parse", []],
      ["registry", ["--check"]],
      ["modules", []],
    ]) {
      const status = runEngine(step, stepArgs, config);
      if (status !== 0) return status;
    }
    return 0;
  }
  if (command === "inventory") {
    return runEngine("mutate", ["--inventory", ...args], config);
  }
  return runEngine(command, args, config);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(path.resolve(process.argv[1])) ===
    fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runCli().then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(
        `[saasist-proof] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
    },
  );
}
