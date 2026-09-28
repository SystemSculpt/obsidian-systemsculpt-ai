import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const relative = (file) => path.relative(root, file).split(path.sep).join("/");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "tests", "testing"].includes(entry.name) ? [] : sources(file);
    }
    return /\.[cm]?tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}

// Parse imports, including type-only and lazy imports. Text searches mistake
// comments for dependencies and miss aliases or alternative import syntax.
function imports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      result.push({
        specifier: specifier.text,
        line: source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

const presentation = /^src\/(views|modals|components|settings)\//;
const rules = [
  {
    owner: "src/platform/",
    accepts: (target) => target.startsWith("src/platform/"),
    reason: "The host seam cannot depend on a feature or the composition root.",
  },
  ...["src/chat/", "src/studio/", "src/tools/vault/", "src/core/diagnostics/", "src/utils/"].map((owner) => ({
    owner,
    accepts: (target) => !presentation.test(target),
    reason: "Domain policy and shared utilities cannot depend on presentation implementations.",
  })),
];

test("module owners do not import their presentation callers", () => {
  const failures = [];
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  for (const file of sources(path.join(root, "src"))) {
    const from = relative(file);
    const rule = rules.find(({ owner }) => from.startsWith(owner));
    if (!rule) continue;
    for (const dependency of imports(file, fs.readFileSync(file, "utf8"))) {
      if (!/^(\.|@\/|src\/)/.test(dependency.specifier)) continue;
      const resolved = ts.resolveModuleName(dependency.specifier, file, options, ts.sys, cache).resolvedModule;
      assert.ok(resolved, `${from}:${dependency.line} cannot resolve ${dependency.specifier}`);
      const target = relative(resolved.resolvedFileName);
      if (!rule.accepts(target)) {
        failures.push(`${from}:${dependency.line} → ${target}\n  ${rule.reason}`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("dependency detection covers runtime, re-export, and type seams without matching comments", () => {
  const dependencies = imports("example.ts", `
    // import { fake } from './comment';
    import type { Contract } from '@/contract';
    import { value } from './value';
    export { value } from './reexport';
    export * from './all';
    type Other = import('./type').Other;
    import legacy = require('./legacy');
    const lazy = import('./lazy');
    const required = require('./required');
  `);
  assert.deepEqual(dependencies.map(({ specifier }) => specifier), [
    "@/contract", "./value", "./reexport", "./all", "./type", "./legacy", "./lazy", "./required",
  ]);
});
