import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const desktopHostSeam = "src/platform/desktopOnly.ts";
const hostCapabilitySeam = "src/platform/hostCapabilities.ts";
const mobileLayoutSeam = "src/platform/mobileLayout.ts";
const mobileHostLayoutSeam = "src/platform/mobileHostLayout.ts";
const ignoredDirectories = new Set(["__tests__", "__mocks__", "tests", "mocks"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

function toRepoPath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function runtimeSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) {
      return [];
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return runtimeSourceFiles(entryPath);
    }
    if (
      !entry.isFile()
      || !sourceExtensions.has(path.extname(entry.name))
      || entry.name.endsWith(".d.ts")
      || /\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
    ) {
      return [];
    }
    return [entryPath];
  });
}

function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/, "");
  return specifier.startsWith("node:") || nodeBuiltins.has(normalized);
}

function sourceLocation(source, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${line + 1}:${character + 1}`;
}

function findMobileHazards(filePath) {
  const repoPath = toRepoPath(filePath);
  if (repoPath === desktopHostSeam) {
    return [];
  }

  const code = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hazards = [];

  const record = (node, message) => {
    hazards.push(`${repoPath}:${sourceLocation(source, node)} ${message}`);
  };

  const recordModuleSpecifier = (node, specifier) => {
    if (specifier && isNodeBuiltin(specifier.text)) {
      record(node, `imports Node builtin ${JSON.stringify(specifier.text)} outside ${desktopHostSeam}`);
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordModuleSpecifier(node, node.moduleSpecifier);
    }

    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && ts.isStringLiteral(argument) && isNodeBuiltin(argument.text)) {
        record(node, `loads Node builtin ${JSON.stringify(argument.text)} outside ${desktopHostSeam}`);
      }
    }

    if (ts.isIdentifier(node) && node.text === "Buffer") {
      record(node, `assumes the Node Buffer global outside ${desktopHostSeam}`);
    }

    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "process"
      && node.name.text === "platform"
    ) {
      record(node, "uses process.platform instead of Obsidian Platform");
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return hazards;
}

function findHostBoundaryHazards(filePath) {
  const repoPath = toRepoPath(filePath);
  const source = fs.readFileSync(filePath, "utf8");
  const hazards = [];
  if (
    ![desktopHostSeam, hostCapabilitySeam, mobileLayoutSeam].includes(repoPath)
    && /\bPlatform\b/.test(source)
  ) {
    hazards.push(`${repoPath} reads Obsidian Platform outside the platform seams`);
  }
  if (repoPath !== hostCapabilitySeam && /["']electron["']/.test(source)) {
    hazards.push(`${repoPath} resolves Electron outside ${hostCapabilitySeam}`);
  }
  if (repoPath !== mobileHostLayoutSeam && /\.mobile-navbar-action/.test(source)) {
    hazards.push(`${repoPath} depends on Obsidian's private mobile navbar DOM`);
  }
  if (repoPath !== mobileLayoutSeam && /["']is-mobile["']/.test(source)) {
    hazards.push(`${repoPath} consumes Obsidian's host class instead of owned mobile state`);
  }
  return hazards;
}

function findCssMobileHazards(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return /\.is-mobile|\.mobile-navbar-action/.test(source)
    ? [`${toRepoPath(filePath)} targets private Obsidian mobile selectors`]
    : [];
}

test("runtime source is safe to load in Obsidian Mobile", () => {
  const hazards = runtimeSourceFiles(sourceRoot).flatMap(findMobileHazards);
  assert.deepEqual(hazards, [], hazards.join("\n"));
});

test("manifest advertises desktop and mobile support", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(
    manifest.isDesktopOnly,
    false,
    "manifest.json isDesktopOnly must stay false once runtime source is mobile-safe",
  );
});

test("features consume owned host capabilities and mobile layout state", () => {
  const hazards = runtimeSourceFiles(sourceRoot).flatMap(findHostBoundaryHazards);

  const cssFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? cssFiles(entryPath) : [entryPath];
    })
    .filter((filePath) => filePath.endsWith(".css"));
  hazards.push(...cssFiles(path.join(sourceRoot, "css")).flatMap(findCssMobileHazards));

  assert.deepEqual(hazards, [], hazards.join("\n"));
});

test("the policy rejects representative mobile regressions", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "systemsculpt-mobile-policy-"));
  try {
    const sourceFixture = path.join(fixtureRoot, "unsafe.ts");
    fs.writeFileSync(
      sourceFixture,
      [
        'import fs from "node:fs";',
        'import electron from "electron";',
        'import { Platform } from "obsidian";',
        'const payload = Buffer.from(process.platform);',
        'const hostNav = ".mobile-navbar-action";',
        'const hostClass = "is-mobile";',
        "void fs; void electron; void Platform; void payload; void hostNav; void hostClass;",
      ].join("\n"),
    );
    const sourceHazards = [
      ...findMobileHazards(sourceFixture),
      ...findHostBoundaryHazards(sourceFixture),
    ].join("\n");
    assert.match(sourceHazards, /imports Node builtin "node:fs"/);
    assert.match(sourceHazards, /assumes the Node Buffer global/);
    assert.match(sourceHazards, /uses process\.platform/);
    assert.match(sourceHazards, /reads Obsidian Platform outside the platform seams/);
    assert.match(sourceHazards, /resolves Electron outside/);
    assert.match(sourceHazards, /private mobile navbar DOM/);
    assert.match(sourceHazards, /owned mobile state/);

    const cssFixture = path.join(fixtureRoot, "unsafe.css");
    fs.writeFileSync(cssFixture, ".is-mobile .fixture, .mobile-navbar-action { display: none; }\n");
    assert.match(findCssMobileHazards(cssFixture).join("\n"), /private Obsidian mobile selectors/);
  } finally {
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
