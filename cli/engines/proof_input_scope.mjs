import ts from "typescript";
const workspace = (name) => /^(workspaceId|workspace_id)$/.test(name);
function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}
function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node))
  )
    node = node.expression;
  return node;
}

/** Trace caller input bindings, never result fields, comments or SQL keys. */
export function actionAcceptsWorkspaceInput(
  source,
  checker,
  exportName,
  problems,
) {
  let owner;
  visit(source, (node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText(source) === exportName
    )
      owner = node;
  });
  if (owner && ts.isVariableDeclaration(owner))
    owner = unwrap(owner.initializer);
  if (
    !owner ||
    !(
      ts.isFunctionDeclaration(owner) ||
      ts.isArrowFunction(owner) ||
      ts.isFunctionExpression(owner)
    )
  )
    return false;
  const inputs = new Map();
  const containers = new Set();
  let found = false;
  const symbol = (node) => checker.getSymbolAtLocation(node);
  const typeHasWorkspace = (type, seen = new Set()) => {
    if (!type || seen.has(type)) return false;
    seen.add(type);
    return checker
      .getPropertiesOfType(type)
      .some(
        (p) =>
          workspace(p.name) ||
          (p.name !== "contextParams" &&
            p.valueDeclaration &&
            typeHasWorkspace(
              checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration),
              seen,
            )),
      );
  };
  function bind(name, state) {
    if (ts.isIdentifier(name)) {
      inputs.set(symbol(name), state);
      return;
    }
    if (ts.isObjectBindingPattern(name))
      for (const element of name.elements) {
        const key = (element.propertyName ?? element.name)
          .getText(source)
          .replace(/["']/g, "");
        if (workspace(key)) {
          if (state === "known") found = true;
          else
            problems.push("workspace input passes through unresolved dataflow");
        }
        bind(element.name, state);
      }
  }
  for (const parameter of owner.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      if (parameter.name.text === "contextParams") continue;
      if (workspace(parameter.name.text)) found = true;
      const type = checker.getTypeAtLocation(parameter);
      const nested = type.getProperty("inputParams");
      if (nested) {
        containers.add(symbol(parameter.name));
        if (
          typeHasWorkspace(checker.getTypeOfSymbolAtLocation(nested, parameter))
        )
          found = true;
      } else {
        bind(parameter.name, "known");
        if (typeHasWorkspace(type)) found = true;
      }
    } else if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        const key = (element.propertyName ?? element.name).getText(source);
        if (key === "contextParams") continue;
        bind(element.name, "known");
        if (
          workspace(key) ||
          typeHasWorkspace(checker.getTypeAtLocation(element))
        )
          found = true;
      }
    }
  }
  function state(node) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isIdentifier(node)) return inputs.get(symbol(node));
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression?.text;
      if (
        ts.isIdentifier(node.expression) &&
        containers.has(symbol(node.expression))
      )
        return key === "inputParams" ? "known" : undefined;
      return state(node.expression);
    }
    if (ts.isCallExpression(node)) {
      const fromInput = node.arguments.map(state).find(Boolean);
      if (fromInput)
        return ts.isPropertyAccessExpression(node.expression) &&
          ["parse", "safeParse"].includes(node.expression.name.text)
          ? fromInput
          : "unknown";
    }
    return undefined;
  }
  const declarations = [];
  visit(owner, (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
  });
  for (let pass = 0; pass <= declarations.length; pass++)
    for (const node of declarations) {
      const input = state(node.initializer);
      if (input) {
        bind(
          node.name,
          node.parent.flags & ts.NodeFlags.Const ? input : "unknown",
        );
      }
    }
  visit(owner, (node) => {
    if (
      !(
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      )
    )
      return;
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression?.text;
    const input = state(node.expression);
    if (workspace(key) && input) {
      if (input === "known") found = true;
      else problems.push("workspace input passes through unresolved dataflow");
    }
    if (
      ts.isElementAccessExpression(node) &&
      input &&
      !ts.isStringLiteral(node.argumentExpression)
    )
      problems.push("dynamic caller input key cannot be assessed");
  });
  return found;
}
