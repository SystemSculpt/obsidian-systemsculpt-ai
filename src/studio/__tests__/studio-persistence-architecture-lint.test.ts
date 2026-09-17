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

describe("Studio persistence architecture lint", () => {
  it("keeps Studio project-local mutations behind the generation store using AST call and import analysis", () => {
    const mutationMethods = new Set(["write", "writeBinary", "append", "remove", "rename", "mkdir", "rmdir", "create", "createBinary", "modify", "modifyBinary", "delete", "renameFile"]);
    const persistenceFiles = new Set([
      "src/studio/persistence/ObsidianStudioGenerationAdapter.ts",
      "src/studio/persistence/StudioProjectGenerationStore.ts",
      "src/studio/persistence/StudioProjectRecoveryStore.ts",
    ]);
    const allowedNonProjectContexts = new Set([
      "src/core/diagnostics/DiagnosticsSessionLifecycle.ts#run",
      "src/core/diagnostics/DiagnosticsSessionLifecycle.ts#rotate",
      // Vault-level generated agent documentation, not project-local state.
      "src/studio/StudioAgentReferenceFile.ts#ensureCurrent",
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
});
