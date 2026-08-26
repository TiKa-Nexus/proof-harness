#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scan_proof_capabilities.mjs
//
// v1 proof SDK capability scanner.
//
// Walks every server-action source file under:
//   - app/__core/<module>/src/actions/**/*.ts
//   - app/__business-logic/<module>/src/actions/**/*.ts
//   - app/__extensions/<module>/src/actions/**/*.ts
//
// For each file it tries to extract:
//   - name       — the literal string passed as `createAction({ functionName })`
//   - module     — the <module> segment from the file path
//   - verb       — literal `verb` on `.use(withProof({ ... }))` if present
//   - object     — literal `object` on withProof if present
//   - invariants — literal string array on withProof if present
//   - acceptsWorkspaceId — whether the action input declares/uses workspaceId
//   - internalOnly — BOT/server-only plumbing rather than a user action
//   - usesDirectUpdateTag — incompatible with proof Route Handler invocation
//   - serviceRoleMutations — tables mutated through a service-role client
//
// Writes `.proof/capabilities.json`. Output is deterministic (sorted,
// no timestamps) so `git diff --exit-code` is a meaningful freshness gate
// in CI; it only fires when the inputs actually changed.
//
// This is the v1 scanner: regex + glob, zero AST. It intentionally ignores:
//   - computed function names (template literals, variable references)
//   - `withProof` declarations outside the same file as `createAction`
//   - chained middleware where the literal spans multiple lines awkwardly
// Any file with `createAction(` that the regex can't parse lands in
// `unclassified[]` with a reason so the author sees it instead of a
// silently-missing capability.
//
// v2 will swap this for a ts-morph / TypeScript compiler API scanner that
// resolves variables, follows re-exports, and handles dynamic shapes. The
// output shape here is the stable contract — v2 just widens coverage.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProofConfig } from "../config.mjs";

const CONFIG = await loadProofConfig();
process.chdir(CONFIG.rootDir);

const ROOTS = CONFIG.roots.actions;
const OUTPUT_PATH = CONFIG.artifacts.capabilities;

function listActionFiles() {
  const files = [];
  for (const root of ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const actionsDir = path.join(root, entry.name, "src", "actions");
      if (fs.existsSync(actionsDir)) {
        walkTs(actionsDir, files);
      }
    }
  }
  return files;
}

function walkTs(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests" || entry.name === "node_modules") continue;
      walkTs(full, acc);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(full);
    }
  }
}

function extractModule(file) {
  for (const root of ROOTS) {
    const relative = path.relative(root, file);
    if (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return relative.split(path.sep)[0] ?? null;
    }
  }
  const parts = file.split(path.sep);
  const rootIdx = parts.findIndex(
    (p) => p === "__core" || p === "__business-logic" || p === "__extensions",
  );
  if (rootIdx < 0 || rootIdx + 1 >= parts.length) return null;
  return parts[rootIdx + 1];
}

/**
 * Resolve the TABLE_NAME_* constants used by the repository's query builders.
 *
 * The scanner remains deliberately shallow, but resolving these constants is
 * important: generated actions conventionally call `.from(TABLE_NAME_WIDGETS)`
 * rather than spelling the table as a string literal. Ambiguous identifiers
 * are dropped so a same-named constant in two modules cannot be resolved to the
 * wrong table.
 */
function readTableConstants() {
  const values = new Map();
  const ambiguous = new Set();

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (entry.isFile() && entry.name === "queries.ts") {
        const source = stripComments(fs.readFileSync(full, "utf8"));
        for (const match of source.matchAll(
          /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g,
        )) {
          const [, identifier, table] = match;
          const existing = values.get(identifier);
          if (existing && existing !== table) ambiguous.add(identifier);
          else values.set(identifier, table);
        }
      }
    }
  }

  walk(CONFIG.roots.source);
  for (const identifier of ambiguous) values.delete(identifier);
  return values;
}

// `[\s\S]` rather than `.` with /s flag: tolerates any content (nested
// objects, comments) until we hit `functionName`. The non-greedy `*?`
// keeps the match tight.
const CREATE_ACTION_RE = /createAction\s*\(\s*\{([\s\S]*?)\}\s*\)/;
const FUNCTION_NAME_RE = /\bfunctionName\s*:\s*["']([^"']+)["']/;
const WITH_PROOF_RE = /\bwithProof\s*\(\s*\{([\s\S]*?)\}\s*\)/;
const VERB_RE = /\bverb\s*:\s*["']([^"']+)["']/;
const OBJECT_RE = /\bobject\s*:\s*["']([^"']+)["']/;
const INVARIANTS_RE = /\binvariants\s*:\s*\[([\s\S]*?)\]/;
const STRING_LITERALS_RE = /["']([^"'\\]+)["']/g;
const SERVICE_CLIENT_ASSIGNMENT_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createSupabaseServiceClient\s*\(\s*\)/g;
const EXPORTED_FUNCTION_RE =
  /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

// Strip `// line` comments and `/* block */` comments before regex matching
// so commented-out examples in JSDoc don't produce false positives. This is
// naive (doesn't handle strings containing `//`) but sufficient for the
// repo's code style. False positives fail loudly when the capabilities.json
// diff lights up — that's an acceptable signal.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

function extractStringArrayLiterals(body) {
  if (!body) return [];
  const out = [];
  for (const m of body.matchAll(STRING_LITERALS_RE)) out.push(m[1]);
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveTableExpression(expression, tableConstants) {
  const literal = expression.match(/^["']([^"']+)["']$/);
  if (literal) return literal[1];
  return tableConstants.get(expression) ?? null;
}

function extractServiceRoleMutations(src, tableConstants) {
  const clientNames = [...src.matchAll(SERVICE_CLIENT_ASSIGNMENT_RE)].map(
    (match) => match[1],
  );
  const mutations = new Map();

  for (const clientName of new Set(clientNames)) {
    const escapedClient = escapeRegExp(clientName);
    // Stop before the next `.from()` call on this client so a SELECT followed
    // by a later UPDATE is not misclassified as one mutating query chain.
    const mutationRe = new RegExp(
      `\\b${escapedClient}\\s*\\.\\s*from\\s*\\(\\s*(` +
        `["'][^"']+["']|[A-Za-z_$][\\w$]*` +
        `)\\s*\\)(?:(?!\\b${escapedClient}\\s*\\.\\s*from\\s*\\()[\\s\\S])*?` +
        `\\.\\s*(insert|upsert|update|delete)\\s*\\(`,
      "g",
    );

    for (const match of src.matchAll(mutationRe)) {
      const table = resolveTableExpression(match[1], tableConstants);
      if (!table) continue;
      const operation = match[2];
      mutations.set(`${table}:${operation}`, { table, operation });
    }
  }

  return [...mutations.values()].sort((a, b) =>
    `${a.table}:${a.operation}`.localeCompare(`${b.table}:${b.operation}`),
  );
}

function scanFile(file, tableConstants) {
  const raw = fs.readFileSync(file, "utf8");
  const src = stripComments(raw);
  const relFile = path.relative(process.cwd(), file);

  // Only process files that actually invoke createAction at runtime. The
  // middleware/utils files that *define* createAction are excluded by the
  // action-dir glob, but this is an extra guard.
  if (!/\bcreateAction\s*\(/.test(src)) return null;

  const caMatch = src.match(CREATE_ACTION_RE);
  if (!caMatch) {
    return {
      kind: "unclassified",
      file: relFile,
      reason:
        "createAction call present but the `createAction({ ... })` literal could not be matched by the v1 regex; check for multi-line or computed syntax",
    };
  }

  const fnMatch = caMatch[1].match(FUNCTION_NAME_RE);
  if (!fnMatch) {
    return {
      kind: "unclassified",
      file: relFile,
      reason:
        "createAction({ ... }) present but `functionName` is missing or computed; scanner only reads string literals in v1",
    };
  }

  const name = fnMatch[1];
  const exportName = src.match(EXPORTED_FUNCTION_RE)?.[1] ?? null;
  const moduleName = extractModule(file);
  if (!moduleName) {
    return {
      kind: "unclassified",
      file: relFile,
      reason:
        "could not determine module from path (expected `app/__<kind>/<module>/src/actions/...`)",
    };
  }

  let verb = null;
  let object = null;
  let invariants = [];
  // Require a caller-controlled workspaceId signal. Looking only before
  // createAction misses the template's common `formData.workspaceId` shape,
  // while searching for any `workspaceId` would misclassify acceptInvitation,
  // which derives the workspace from a trusted token after validation.
  const acceptsWorkspaceId =
    /\bworkspace_?id\b/i.test(src.slice(0, caMatch.index)) ||
    /\b(?:inputParams|formData)\s*\.\s*workspaceId\b/.test(src);
  const internalOnly =
    file.endsWith("_BOT.ts") ||
    /^\s*import\s+["']server-only["']\s*;?/m.test(src);
  const usesDirectUpdateTag =
    /\bimport\s*\{[^}]*\bupdateTag\b[^}]*\}\s*from\s*["']next\/cache["']/.test(
      src,
    );
  const serviceRoleMutations = extractServiceRoleMutations(src, tableConstants);
  const middleware = {
    auth: /\bwithAuth\s*\(/.test(src),
    tenantIsolation: /\bwithTenantIsolation\s*\(/.test(src),
    rbac: /\bwithRBAC\s*\(/.test(src),
  };

  const pfMatch = src.match(WITH_PROOF_RE);
  if (pfMatch) {
    const body = pfMatch[1];
    verb = body.match(VERB_RE)?.[1] ?? null;
    object = body.match(OBJECT_RE)?.[1] ?? null;
    const invBody = body.match(INVARIANTS_RE)?.[1];
    invariants = extractStringArrayLiterals(invBody);
  }

  return {
    kind: "capability",
    capability: {
      name,
      module: moduleName,
      exportName,
      verb,
      object,
      invariants,
      acceptsWorkspaceId,
      internalOnly,
      usesDirectUpdateTag,
      serviceRoleMutations,
      middleware,
      file: relFile.split(path.sep).join("/"),
    },
  };
}

export function main() {
  const files = listActionFiles();
  const tableConstants = readTableConstants();
  const capabilities = [];
  const unclassified = [];

  for (const file of files) {
    const result = scanFile(file, tableConstants);
    if (!result) continue;
    if (result.kind === "capability") {
      capabilities.push(result.capability);
    } else {
      unclassified.push({ file: result.file, reason: result.reason });
    }
  }

  capabilities.sort((a, b) => {
    const ka = `${a.module}:${a.name}`;
    const kb = `${b.module}:${b.name}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  unclassified.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // Deterministic output: no generatedAt timestamp. The freshness check is
  // `git diff --exit-code`; a timestamp would trip it on every run.
  const output = {
    schemaVersion: 1,
    capabilities,
    unclassified,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  const total = capabilities.length + unclassified.length;
  console.log(
    `[proof:scan] scanned ${files.length} action file(s); wrote ${capabilities.length} capabilities, ${unclassified.length} unclassified (total ${total}) to ${OUTPUT_PATH}`,
  );
  if (unclassified.length > 0) {
    console.log(`[proof:scan] unclassified entries:`);
    for (const u of unclassified) console.log(`  - ${u.file}: ${u.reason}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
