import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(__dirname, "../../..");
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, "src/studio"),
  resolve(REPO_ROOT, "src/views/studio"),
  resolve(REPO_ROOT, "src/views/history"),
];
const SOURCE_FILES = [resolve(REPO_ROOT, "src/main.ts")];
const ALLOWED_LEGACY_NODE_MUTATION_FILES = [
  "src/views/studio/graph-v3/StudioGraphImageEditorModal.ts",
  "src/views/studio/graph-v3/StudioGraphInlineConfigPanel.ts",
  "src/views/studio/graph-v3/StudioGraphJsonInlineEditor.ts",
  "src/views/studio/graph-v3/StudioGraphNodeCardSections.ts",
  "src/views/studio/graph-v3/StudioGraphNodeResizeFrame.ts",
  "src/views/studio/graph-v3/StudioGraphTextInlineEditor.ts",
  "src/views/studio/graph-v3/StudioGraphTextNodeCard.ts",
];

function listSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        if (entry === "__tests__") {
          continue;
        }
        visit(fullPath);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
        continue;
      }
      files.push(fullPath);
    }
  };
  for (const root of SOURCE_ROOTS) {
    visit(root);
  }
  files.push(...SOURCE_FILES);
  return files.sort();
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

function findTokenMatches(token: RegExp): string[] {
  const matches: string[] = [];
  for (const filePath of listSourceFiles()) {
    const content = readFileSync(filePath, "utf8");
    if (token.test(content)) {
      matches.push(relative(REPO_ROOT, filePath).replace(/\\/g, "/"));
    }
    token.lastIndex = 0;
  }
  return matches.sort();
}

describe("Studio persistence architecture lint", () => {
  it("keeps Studio project-local mutations behind the generation store using AST call and import analysis", () => {
    const mutationMethods = new Set(["write", "writeBinary", "append", "remove", "rename", "mkdir", "rmdir", "create", "createBinary", "modify", "modifyBinary", "delete", "renameFile"]);
    const persistenceFiles = new Set([
      "src/studio/persistence/ObsidianStudioGenerationAdapter.ts",
      "src/studio/persistence/StudioProjectGenerationStore.ts",
    ]);
    const allowedNonProjectContexts = new Set([
      "src/main.ts#rotateDiagnosticsFile",
      "src/studio/StudioApiExecutionAdapter.ts#removeTempPath",
      "src/studio/StudioApiExecutionAdapter.ts#ensureDir",
      "src/studio/StudioApiExecutionAdapter.ts#writeBinary",
      "src/studio/StudioApiExecutionAdapter.ts#writeTempAudioFile",
    ]);
    const violations: string[] = [];
    for (const filePath of listSourceFiles()) {
      const relativePath = relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const destructuredMutationAliases = new Set<string>();
      const storageAliases = new Set<string>(["adapter", "vault", "fileManager"]);
      const referencesStorage = (text: string): boolean => /adapter|vault|fileManager/i.test(text) || [...storageAliases].some((alias) => new RegExp(`\\b${alias}\\b`).test(text));
      const visit = (node: ts.Node, context = "<module>"): void => {
        let nextContext = context;
        if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) nextContext = node.name.text;
        if (ts.isFunctionDeclaration(node) && node.name) nextContext = node.name.text;
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const imported = node.moduleSpecifier.text;
          if (relativePath.startsWith("src/views/") && imported.includes("studio/persistence")) violations.push(`${relativePath}: imports persistence internals`);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && referencesStorage(node.initializer.getText(source))) storageAliases.add(node.name.text);
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && referencesStorage(node.initializer.getText(source))) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
            if (mutationMethods.has(property)) destructuredMutationAliases.add(element.name.text);
          }
        }
        if (ts.isCallExpression(node)) {
          let method: string | null = null;
          let storageReceiver = false;
          if (ts.isPropertyAccessExpression(node.expression)) {
            method = node.expression.name.text;
            storageReceiver = referencesStorage(node.expression.expression.getText(source));
          } else if (ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression)) {
            method = node.expression.argumentExpression.text;
            storageReceiver = referencesStorage(node.expression.expression.getText(source));
          } else if (ts.isIdentifier(node.expression) && destructuredMutationAliases.has(node.expression.text)) {
            method = node.expression.text;
            storageReceiver = true;
          }
          if (storageReceiver && method && mutationMethods.has(method) && !persistenceFiles.has(relativePath) && !allowedNonProjectContexts.has(`${relativePath}#${nextContext}`)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            violations.push(`${relativePath}:${line}:${nextContext}:${method}`);
          }
        }
        ts.forEachChild(node, (child) => visit(child, nextContext));
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it("exposes only closed typed generation commands, never raw Map transforms", () => {
    const source = readRepoFile("src/studio/persistence/StudioProjectGenerationStore.ts");
    expect(source).not.toContain("transform:");
    expect(source).not.toMatch(/commitWholeGeneration\([^)]*Map/);
    expect(source).toContain('kind: "publish_run"');
  });

  it("removes the old scheduleProjectSave seam from production Studio source", () => {
    expect(findTokenMatches(/scheduleProjectSave\(/g)).toEqual([]);
  });

  it("keeps legacy onNodeConfigMutated call sites confined to explicit fallback adapters", () => {
    expect(findTokenMatches(/onNodeConfigMutated\(/g)).toEqual(ALLOWED_LEGACY_NODE_MUTATION_FILES);
  });

  it("prevents view-layer production code from importing graph mutation helpers from old helper paths", () => {
    const offendingFiles: string[] = [];
    const viewOnlyFiles = listSourceFiles().filter((filePath) =>
      relative(REPO_ROOT, filePath).replace(/\\/g, "/").startsWith("src/views/studio/")
    );
    const forbiddenImports = [
      'from "./StudioManagedOutputNodes"',
      'from "../StudioManagedOutputNodes"',
      'from "./systemsculpt-studio-view/StudioRunOutputProjectors"',
      'from "../systemsculpt-studio-view/StudioRunOutputProjectors"',
      'from "./graph-v3/StudioGraphGroupModel"',
      'from "../graph-v3/StudioGraphGroupModel"',
    ];
    for (const filePath of viewOnlyFiles) {
      const relativePath = relative(REPO_ROOT, filePath).replace(/\\/g, "/");
      const content = readFileSync(filePath, "utf8");
      if (forbiddenImports.some((token) => content.includes(token))) {
        offendingFiles.push(relativePath);
      }
    }
    expect(offendingFiles).toEqual([]);
  });

  it("keeps load-time project repair core-owned", () => {
    const viewSource = readRepoFile("src/views/studio/SystemSculptStudioView.ts");
    expect(viewSource).toContain("repairStudioProjectForLoad(");
    expect(viewSource).not.toContain("sanitizeGraphGroups(currentProject)");
    expect(viewSource).not.toContain("normalizeLegacyMediaNodeTitles(currentProject)");
    expect(viewSource).not.toContain("cleanupStaleManagedOutputPlaceholders(currentProject)");
    expect(viewSource).not.toContain("removeManagedTextOutputNodes({ project: currentProject })");
  });

  it("keeps session-backed runs on the runtime snapshot path", () => {
    const serviceSource = readRepoFile("src/studio/StudioService.ts");
    expect(serviceSource).toContain("const projectSnapshot = session.getProjectSnapshot();");
    expect(serviceSource).toContain("return this.runtime.runProjectSnapshot(normalized, projectSnapshot, {");
    expect(serviceSource).toContain(
      "return this.runtime.runProjectSnapshot(normalized, projectSnapshot, {\n      entryNodeIds: [normalizedNodeId],"
    );
  });

  it("keeps StudioService free of global current-project session state", () => {
    const serviceSource = readRepoFile("src/studio/StudioService.ts");
    // Sessions are owned per-view through retain/release refcounting; a
    // service-level "current" pointer is the root cause of cross-tab
    // corruption (#286) and must not come back.
    expect(serviceSource).not.toMatch(/currentProjectPath/);
    expect(serviceSource).not.toMatch(/currentProjectSession/);
    expect(serviceSource).not.toMatch(/mutateCurrentProject/);
    expect(serviceSource).not.toMatch(/openProjectSession\(/);
    expect(serviceSource).not.toMatch(/closeCurrentProject/);
    expect(serviceSource).toContain("retainProjectSession(");
    expect(serviceSource).toContain("releaseProjectSession(");
  });

  it("keeps production Studio sources off the removed current-project service seams", () => {
    expect(findTokenMatches(/mutateCurrentProject(Async|AndFlush)?\(/g)).toEqual([]);
    expect(findTokenMatches(/getCurrentProjectPath\(/g)).toEqual([]);
    expect(findTokenMatches(/getCurrentProjectSession\(/g)).toEqual([]);
    expect(findTokenMatches(/closeCurrentProject\(/g)).toEqual([]);
    expect(findTokenMatches(/runCurrentProject(FromNode)?\(/g)).toEqual([]);
  });
});
