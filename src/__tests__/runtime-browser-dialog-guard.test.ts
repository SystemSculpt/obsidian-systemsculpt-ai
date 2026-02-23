import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const BANNED_GLOBAL_DIALOGS = new Set(["prompt", "confirm", "alert"]);

function walkDir(dirPath: string): string[] {
  const output: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      output.push(...walkDir(fullPath));
      continue;
    }
    output.push(fullPath);
  }
  return output;
}

function isRuntimeSourceFile(repoRelativePath: string): boolean {
  if (!repoRelativePath.endsWith(".ts")) return false;
  if (repoRelativePath.endsWith(".d.ts")) return false;
  if (repoRelativePath.includes("/__tests__/")) return false;
  if (repoRelativePath.startsWith("tests/")) return false;
  if (repoRelativePath.includes("/mocks/")) return false;
  return true;
}

function detectForbiddenDialogs(filePath: string, repoRelativePath: string): string[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let forbiddenName: string | null = null;

      if (ts.isIdentifier(expression) && BANNED_GLOBAL_DIALOGS.has(expression.text)) {
        forbiddenName = expression.text;
      } else if (ts.isPropertyAccessExpression(expression)) {
        const owner = expression.expression;
        const method = expression.name.text;
        if (
          ts.isIdentifier(owner) &&
          (owner.text === "window" || owner.text === "globalThis") &&
          BANNED_GLOBAL_DIALOGS.has(method)
        ) {
          forbiddenName = `${owner.text}.${method}`;
        }
      }

      if (forbiddenName) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${repoRelativePath}:${start.line + 1}:${start.character + 1} uses ${forbiddenName}()`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

describe("runtime browser dialog guard", () => {
  it("disallows prompt/confirm/alert in runtime source files", () => {
    const srcRoot = path.resolve(__dirname, "..");
    const allFiles = walkDir(srcRoot);
    const runtimeFiles = allFiles
      .map((fullPath) => ({
        fullPath,
        repoRelativePath: path.relative(srcRoot, fullPath).replace(/\\/g, "/"),
      }))
      .filter((entry) => isRuntimeSourceFile(entry.repoRelativePath));

    const violations: string[] = [];
    for (const file of runtimeFiles) {
      violations.push(...detectForbiddenDialogs(file.fullPath, file.repoRelativePath));
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "Forbidden browser dialog APIs found in runtime source.",
          ...violations,
          "Use Studio view-native inputs or showConfirm/showAlert utilities instead.",
        ].join("\n")
      );
    }
  });
});
