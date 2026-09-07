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
// TypeScript syntax analysis handles import aliases and multiple actions.
// Unsupported indirection is reported as unclassified and blocks assessment.
// This remains template-shaped discovery, not whole-program dataflow analysis.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { actionAcceptsWorkspaceInput } from "./proof_input_scope.mjs";
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

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function property(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const p = node.properties.find(
    (p) =>
      ts.isPropertyAssignment(p) &&
      p.name.getText().replace(/["']/g, "") === name,
  );
  return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
}
function literal(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}
function unwrap(node) {
  while (
    node &&
    (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))
  )
    node = node.expression;
  return node;
}
function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}
function exportedName(call, source) {
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) &&
      parent.name &&
      parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      return parent.name.text;
    if (
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name) &&
      parent.parent.parent.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      )
    )
      return parent.name.text;
  }
  const exports = source.statements.filter(
    (n) =>
      ts.isFunctionDeclaration(n) &&
      n.name &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
  return exports.length === 1 ? exports[0].name.text : null;
}
function scanFile(file, constants) {
  // Bind identifiers within this file without resolving consumer dependencies.
  const program = ts.createProgram([file], {
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  });
  const source = program.getSourceFile(file);
  const checker = program.getTypeChecker();
  const symbol = (node) => checker.getSymbolAtLocation(node);
  const actionNames = new Set(["createAction"]);
  const factoryNames = new Map([
    ["createSupabaseServiceClient", "service"],
    ["createSupabaseRLSClient", "rls"],
  ]);
  const importedFactories = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const item of bindings.elements) {
      const imported = (item.propertyName ?? item.name).text;
      if (imported === "createAction") actionNames.add(item.name.text);
      if (factoryNames.has(imported))
        importedFactories.set(symbol(item.name), factoryNames.get(imported));
    }
  }
  function factoryKind(node) {
    if (!ts.isIdentifier(node)) return undefined;
    const binding = symbol(node);
    return binding
      ? importedFactories.get(binding)
      : factoryNames.get(node.text);
  }
  const calls = [];
  visit(source, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      actionNames.has(n.expression.text)
    )
      calls.push(n);
  });
  if (!calls.length) {
    const mentionsFactory = [...actionNames].some((name) =>
      new RegExp(`\\b${name}\\b`).test(source.text),
    );
    return {
      capabilities: [],
      unclassified: mentionsFactory
        ? [
            {
              file,
              reason: "action factory cannot be resolved to a direct call",
            },
          ]
        : [],
    };
  }
  const problems = source.parseDiagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, " "),
  );
  visit(source, (n) => {
    if (!ts.isIdentifier(n) || !actionNames.has(n.text)) return;
    if (ts.isImportSpecifier(n.parent)) return;
    if (ts.isCallExpression(n.parent) && n.parent.expression === n) return;
    problems.push("action factory escapes a recognized direct call");
  });
  visit(source, (n) => {
    if (!ts.isIdentifier(n) || !factoryKind(n)) return;
    if (ts.isImportSpecifier(n.parent)) return;
    if (ts.isCallExpression(n.parent) && n.parent.expression === n) return;
    problems.push("client factory escapes a recognized direct call");
  });
  const clients = new Map();
  visit(source, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name)) return;
    const value = unwrap(n.initializer);
    if (!value || !ts.isCallExpression(value)) return;
    const kind = factoryKind(value.expression);
    if (kind) {
      if (!(n.parent.flags & ts.NodeFlags.Const))
        problems.push("known clients must use immutable const bindings");
      clients.set(symbol(n.name), kind);
    }
  });
  const clientKind = (node) =>
    ts.isIdentifier(node) ? clients.get(symbol(node)) : undefined;
  visit(source, (n) => {
    if (!ts.isCallExpression(n)) return;
    const kind = factoryKind(n.expression);
    const isFactory =
      kind ||
      (ts.isPropertyAccessExpression(n.expression) &&
        factoryNames.has(n.expression.name.text));
    if (!isFactory) return;
    let parent = n.parent;
    while (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))
      parent = parent.parent;
    if (
      !ts.isVariableDeclaration(parent) ||
      !ts.isIdentifier(parent.name) ||
      !clientKind(parent.name)
    )
      problems.push("client factory result is not a recognized local client");
  });
  // Keep Auth administrative calls separate from SQL table mutations. In
  // particular deleteUser can soft-delete; it is not a PostgREST DELETE.
  const authOperations = new Set();
  const knownAuthOperations = new Set(["deleteUser"]);
  function authCall(root) {
    let current = root;
    const names = [];
    while (
      ts.isPropertyAccessExpression(current.parent) &&
      current.parent.expression === current
    ) {
      current = current.parent;
      names.push(current.name.text);
    }
    return names.length === 3 &&
      names[0] === "auth" &&
      names[1] === "admin" &&
      ts.isCallExpression(current.parent) &&
      current.parent.expression === current
      ? names[2]
      : undefined;
  }
  const mutations = new Map();
  visit(source, (n) => {
    if (ts.isIdentifier(n) && clientKind(n)) {
      const parent = n.parent;
      const declaration = ts.isVariableDeclaration(parent) && parent.name === n;
      const query =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === n &&
        parent.name.text === "from" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      const adminOperation =
        clientKind(n) === "service" ? authCall(n) : undefined;
      // Authenticated Auth calls are not privileged service operations. Require
      // an uninterrupted call chain; aliases and detached methods remain unknown.
      let authRoot = n;
      const authPath = [];
      while (
        ts.isPropertyAccessExpression(authRoot.parent) &&
        authRoot.parent.expression === authRoot
      ) {
        authRoot = authRoot.parent;
        authPath.push(authRoot.name.text);
      }
      const rlsAuth =
        clientKind(n) === "rls" &&
        authPath[0] === "auth" &&
        authPath[1] !== "admin" &&
        ts.isCallExpression(authRoot.parent) &&
        authRoot.parent.expression === authRoot;
      if (adminOperation && knownAuthOperations.has(adminOperation))
        authOperations.add(adminOperation);
      if (
        !declaration &&
        !query &&
        !rlsAuth &&
        !(adminOperation && knownAuthOperations.has(adminOperation))
      )
        problems.push(
          `${clientKind(n) === "service" ? "service" : "RLS"} client ${n.text} escapes a recognized query chain`,
        );
    }
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression))
      return;
    if (
      n.expression.name.text === "from" &&
      ts.isIdentifier(n.expression.expression) &&
      clientKind(n.expression.expression)
    ) {
      let chain = n;
      while (
        chain.parent &&
        (ts.isPropertyAccessExpression(chain.parent) ||
          ts.isCallExpression(chain.parent)) &&
        chain.parent.expression === chain
      )
        chain = chain.parent;
      let parent = chain.parent;
      let awaited = false;
      while (
        parent &&
        (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))
      ) {
        if (ts.isAwaitExpression(parent)) awaited = true;
        parent = parent.parent;
      }
      if (
        !awaited &&
        (chain === n ||
          !parent ||
          !(
            ts.isReturnStatement(parent) ||
            ts.isExpressionStatement(parent) ||
            (ts.isArrowFunction(parent) && parent.body === chain)
          ))
      )
        problems.push("service query builder escapes its recognized chain");
    }
    const admin = n.expression.expression;
    if (
      ts.isPropertyAccessExpression(admin) &&
      admin.name.text === "admin" &&
      ts.isPropertyAccessExpression(admin.expression) &&
      admin.expression.name.text === "auth" &&
      clientKind(admin.expression.expression) !== "service"
    )
      problems.push(
        "Auth admin call uses a client whose service privilege cannot be resolved",
      );
    const operation = n.expression.name.text;
    if (!["insert", "upsert", "update", "delete"].includes(operation)) return;
    let from = n.expression.expression;
    while (
      ts.isCallExpression(from) &&
      ts.isPropertyAccessExpression(from.expression) &&
      from.expression.name.text !== "from"
    )
      from = from.expression.expression;
    if (
      !ts.isCallExpression(from) ||
      !ts.isPropertyAccessExpression(from.expression) ||
      from.expression.name.text !== "from"
    )
      return;
    const client = from.expression.expression;
    if (!ts.isIdentifier(client) || !clientKind(client)) {
      problems.push(
        "mutation query uses a client whose privilege cannot be resolved",
      );
      return;
    }
    // RLS writes are recognized but must never be promoted to service writes.
    if (clientKind(client) === "rls") return;
    const table =
      literal(from.arguments[0]) ??
      (from.arguments[0] && ts.isIdentifier(from.arguments[0])
        ? constants.get(from.arguments[0].text)
        : undefined);
    if (!table) {
      problems.push(
        "service-role mutation uses an unresolved table expression",
      );
      return;
    }
    mutations.set(`${table}:${operation}`, { table, operation });
  });
  const capabilities = [];
  for (const call of calls) {
    const name = literal(property(call.arguments[0], "functionName"));
    if (!name) {
      problems.push("createAction requires a literal functionName");
      continue;
    }
    let owner = call;
    while (
      owner.parent &&
      (ts.isPropertyAccessExpression(owner.parent) ||
        ts.isCallExpression(owner.parent) ||
        ts.isParenthesizedExpression(owner.parent))
    )
      owner = owner.parent;
    const proofCalls = [];
    visit(owner, (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "withProof"
      )
        proofCalls.push(n);
    });
    const proof =
      proofCalls.length === 1 ? proofCalls[0].arguments[0] : undefined;
    if (proofCalls.length > 1)
      problems.push(`ambiguous withProof metadata for ${name}`);
    if (proof && !ts.isObjectLiteralExpression(proof))
      problems.push(`unresolved withProof metadata for ${name}`);
    const inv = property(proof, "invariants");
    const invariants =
      inv && ts.isArrayLiteralExpression(inv) ? inv.elements.map(literal) : [];
    if (
      inv &&
      (!ts.isArrayLiteralExpression(inv) ||
        invariants.some((v) => v === undefined))
    )
      problems.push(`unresolved invariants for ${name}`);
    const exportName = exportedName(call, source);
    if (!exportName)
      problems.push(`cannot associate ${name} with one exported wrapper`);
    const body = owner.getText(source);
    capabilities.push({
      name,
      module: extractModule(file),
      exportName,
      verb: literal(property(proof, "verb")) ?? null,
      object: literal(property(proof, "object")) ?? null,
      invariants: invariants.filter(Boolean),
      acceptsWorkspaceId: actionAcceptsWorkspaceInput(
        source,
        checker,
        exportName,
        file.endsWith("_BOT.ts") ? [] : problems,
      ),
      internalOnly: file.endsWith("_BOT.ts"),
      usesDirectUpdateTag:
        /import\s*\{[^}]*\bupdateTag\b[^}]*\}\s*from\s*["']next\/cache["']/.test(
          source.text,
        ),
      serviceRoleMutations: [...mutations.values()].sort((a, b) =>
        `${a.table}:${a.operation}`.localeCompare(`${b.table}:${b.operation}`),
      ),
      serviceRoleAuthOperations: [...authOperations].sort(),
      middleware: {
        auth: /\bwithAuth\s*\(/.test(body),
        tenantIsolation: /\bwithTenantIsolation\s*\(/.test(body),
        rbac: /\bwithRBAC\s*\(/.test(body),
      },
      file: path.relative(process.cwd(), file).split(path.sep).join("/"),
    });
  }
  return {
    capabilities,
    unclassified: [...new Set(problems)].map((reason) => ({ file, reason })),
  };
}
export function main() {
  const constants = readTableConstants();
  const scanned = listActionFiles()
    .sort()
    .map((file) => scanFile(file, constants));
  const capabilities = scanned
    .flatMap((r) => r.capabilities)
    .sort((a, b) =>
      `${a.module}:${a.name}`.localeCompare(`${b.module}:${b.name}`),
    );
  const unclassified = scanned.flatMap((r) => r.unclassified);
  const refs = new Set();
  for (const cap of capabilities) {
    const ref = `${cap.module}:${cap.name}`;
    if (refs.has(ref))
      unclassified.push({
        file: cap.file,
        reason: `duplicate capability ${ref}`,
      });
    refs.add(ref);
  }
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ schemaVersion: 1, capabilities, unclassified }, null, 2) +
      "\n",
  );
  console.log(
    `[proof:scan] wrote ${capabilities.length} capabilities, ${unclassified.length} unclassified`,
  );
  if (unclassified.length)
    throw new Error(
      `[PROOF_FAIL] capabilities_unassessed: ${unclassified.map((p) => `${p.file}: ${p.reason}`).join("; ")}`,
    );
}
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
