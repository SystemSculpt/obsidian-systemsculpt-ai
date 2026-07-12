#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const FORBIDDEN_PATHS = [
  /(?:^|\/)services\/entitlement(?:\/|$)/i,
  /(?:^|\/)services\/providerRuntime(?:\/|$)/i,
  /(?:^|\/)services\/pi-native(?:\/|$)/i,
  /(?:^|\/)studio\/piAuth(?:\/|$)/i,
  /(?:^|\/)FavoritesService\.[cm]?[jt]sx?$/i,
  /(?:^|\/)RemoteProviderCatalog\.[cm]?[jt]sx?$/i,
  /(?:^|\/)modelUtils\.[cm]?[jt]sx?$/i,
];

const FORBIDDEN_MEMBERS = new Set([
  "modelService",
  "getModels",
  "getModelById",
  "getCachedModels",
  "getEntitlementService",
  "canUseChat",
  "hasSystemSculptLicense",
  "customProviders",
  "activeProvider",
  "providerRegistry",
  "providerSettings",
  "credentials",
  "endpoints",
  "favorites",
  "piAuth",
]);

function relative(projectRoot, file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

function resolveLocalImport(projectRoot, containingFile, specifier) {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      allowJs: true,
    },
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return null;
  const normalized = path.resolve(resolved.replace(/\.d\.ts$/, ".ts"));
  return normalized.startsWith(path.resolve(projectRoot) + path.sep) ? normalized : null;
}

function sourceFile(file) {
  const source = fs.readFileSync(file, "utf8");
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function importSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

function declarationName(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const name = node.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return name.text;
  return null;
}

function findNamedBodies(root, names) {
  const bodies = [];
  const visit = (node) => {
    const name = declarationName(node);
    if (
      name &&
      names.has(name) &&
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.body
    ) {
      bodies.push({ name, node: node.body });
    }
    if (
      name &&
      names.has(name) &&
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      bodies.push({ name, node: node.initializer.body });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return bodies;
}

export function analyzeStandardChatModelGraph({
  projectRoot,
  moduleRoots = [],
  methodRoots = [],
}) {
  const root = path.resolve(projectRoot);
  const findings = [];
  const visited = new Set();

  const addFinding = (reason, graphPath) => {
    findings.push({ reason, path: graphPath });
  };

  const scanNode = (file, node, graphPath, followImports) => {
    const visit = (current) => {
      const specifier = importSpecifier(current);
      if (specifier?.startsWith(".")) {
        const resolved = resolveLocalImport(root, file, specifier);
        if (!resolved) {
          addFinding(`unresolved import: ${specifier}`, [...graphPath, specifier]);
        } else {
          const target = relative(root, resolved);
          const nextPath = [...graphPath, target];
          const forbidden = FORBIDDEN_PATHS.find((pattern) => pattern.test(target));
          if (forbidden) {
            addFinding(`forbidden import family: ${target}`, nextPath);
          } else if (followImports || current.expression?.kind === ts.SyntaxKind.ImportKeyword) {
            scanModule(resolved, nextPath);
          }
        }
      }

      const member = memberName(current);
      if (member && FORBIDDEN_MEMBERS.has(member)) {
        addFinding(`forbidden member read: ${member}`, [...graphPath, `member:${member}`]);
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
  };

  const scanModule = (file, graphPath) => {
    const absolute = path.resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    if (!fs.existsSync(absolute)) {
      addFinding("missing graph root", graphPath);
      return;
    }
    scanNode(absolute, sourceFile(absolute), graphPath, true);
  };

  for (const moduleRoot of moduleRoots) {
    const file = path.resolve(root, moduleRoot);
    scanModule(file, [relative(root, file)]);
  }

  for (const methodRoot of methodRoots) {
    const file = path.resolve(root, methodRoot.file);
    if (!fs.existsSync(file)) {
      addFinding("missing method root", [relative(root, file)]);
      continue;
    }
    const requested = new Set(methodRoot.names);
    const bodies = findNamedBodies(sourceFile(file), requested);
    const found = new Set(bodies.map(({ name }) => name));
    for (const name of requested) {
      if (!found.has(name)) {
        addFinding(`missing method root: ${name}`, [`${relative(root, file)}#${name}`]);
      }
    }
    for (const { name, node } of bodies) {
      scanNode(file, node, [`${relative(root, file)}#${name}`], false);
    }
  }

  return { ok: findings.length === 0, findings };
}

function checkRepository() {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  return analyzeStandardChatModelGraph({
    projectRoot,
    moduleRoots: [
      "src/views/chatview/modelSelection.ts",
      "src/views/chatview/ChatModelSelectionController.ts",
    ],
    methodRoots: [
      {
        file: "src/views/chatview/InputHandler.ts",
        names: [
          "constructor",
          "getSelectedModelIdForChat",
          "handleReservedSendMessage",
          "handleManagedAdmissionDenied",
        ],
      },
      {
        file: "src/views/chatview/ChatView.ts",
        names: [
          "resolveLeafSelectedModelId",
          "getCurrentModelName",
          "getEffectiveSelectedModelId",
          "getPersistedSelectedModelId",
          "resolveLoadedSelectedModelId",
          "getState",
          "setState",
          "loadChatById",
          "isPiBackedChat",
          "getCurrentSystemPrompt",
          "setSelectedModelId",
        ],
      },
      {
        file: "src/services/chat/ChatRequestPreparationService.ts",
        names: ["prepareManagedAcceptedChatRequest"],
      },
      {
        file: "src/services/chat/AcceptedChatRequestSnapshot.ts",
        names: ["createAcceptedManagedChatRequestSnapshot"],
      },
    ],
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const report = checkRepository();
  if (!report.ok) {
    for (const finding of report.findings) {
      console.error(`${finding.reason}\n  ${finding.path.join(" -> ")}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Standard Chat identity graph is closed.");
  }
}
