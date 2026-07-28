import fs from "node:fs";
import path from "node:path";
import {
  normalizeLineEndings,
  replaceFileAtomically,
} from "./platform-portability.mjs";

const FAILURE_SENTINEL = "/* CSS build failed */\n";

class CssBuildSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CssBuildSecurityError";
  }
}

function parseImports(indexPath) {
  const content = fs.readFileSync(indexPath, "utf8");
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/@import\s+['"](.+)['"]/g)]
    .map((match) => match[1]);
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function escapesRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

function assertSafeOutputPath(outputPath) {
  const stats = lstatIfPresent(outputPath);
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CssBuildSecurityError(
      `CSS output must be absent or an existing regular file: ${outputPath}`,
    );
  }
  return true;
}

function inspectCssSourceRoot(indexPath) {
  const sourceRoot = path.dirname(indexPath);
  const rootStats = lstatIfPresent(sourceRoot);
  const indexStats = lstatIfPresent(indexPath);
  if (
    !rootStats?.isDirectory()
    || rootStats.isSymbolicLink()
    || !indexStats?.isFile()
    || indexStats.isSymbolicLink()
  ) {
    throw new CssBuildSecurityError(
      `CSS entry must be a regular file inside a regular source directory: ${indexPath}`,
    );
  }
  return {
    sourceRoot,
    realSourceRoot: fs.realpathSync(sourceRoot),
  };
}

function resolveCssImport(sourceRoot, realSourceRoot, importPath) {
  const normalizedImportPath = importPath.replace(/\\/g, "/");
  if (
    !normalizedImportPath
    || path.posix.isAbsolute(normalizedImportPath)
    || path.win32.isAbsolute(importPath)
    || normalizedImportPath.split("/").includes("..")
  ) {
    throw new CssBuildSecurityError(
      `CSS import must be a relative path without traversal: ${importPath}`,
    );
  }

  const resolvedPath = path.resolve(sourceRoot, normalizedImportPath);
  if (escapesRoot(sourceRoot, resolvedPath)) {
    throw new CssBuildSecurityError(
      `CSS import must be a relative path without traversal: ${importPath}`,
    );
  }

  const stats = lstatIfPresent(resolvedPath);
  if (!stats) return null;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CssBuildSecurityError(
      `CSS import must resolve to a regular file inside the CSS source root: ${importPath}`,
    );
  }
  const realPath = fs.realpathSync(resolvedPath);
  if (escapesRoot(realSourceRoot, realPath)) {
    throw new CssBuildSecurityError(
      `CSS import must resolve to a regular file inside the CSS source root: ${importPath}`,
    );
  }
  return resolvedPath;
}

export function buildCssArtifact({
  indexPath,
  outputPath,
  production = true,
  logger = console,
} = {}) {
  const resolvedIndexPath = path.resolve(String(indexPath || ""));
  const resolvedOutputPath = path.resolve(String(outputPath || ""));
  const hadExistingOutput = assertSafeOutputPath(resolvedOutputPath);
  let combinedCss;
  let missingFiles;
  let processedCount;
  let startedAt;

  try {
    if (!fs.existsSync(resolvedIndexPath)) {
      throw new Error(`CSS entry file missing at ${resolvedIndexPath}`);
    }

    const { sourceRoot, realSourceRoot } = inspectCssSourceRoot(resolvedIndexPath);
    startedAt = Date.now();
    const imports = parseImports(resolvedIndexPath);
    missingFiles = [];
    combinedCss = `/**\n * SystemSculpt CSS\n * Generated from src/css/ sources.\n * DO NOT EDIT DIRECTLY.\n */\n\n`;
    processedCount = 0;

    for (const importPath of imports) {
      const resolvedPath = resolveCssImport(sourceRoot, realSourceRoot, importPath);
      if (!resolvedPath) {
        missingFiles.push(importPath);
        continue;
      }
      const content = normalizeLineEndings(fs.readFileSync(resolvedPath, "utf8"));
      combinedCss += `/* ${path.basename(importPath)} */\n${content}\n\n`;
      processedCount += 1;
    }

    if (missingFiles.length > 0 && production) {
      throw new Error(`Missing CSS imports: ${missingFiles.join(", ")}`);
    }
  } catch (error) {
    logger.error?.("CSS build failed", error instanceof Error ? error.message : error);
    if (production || error instanceof CssBuildSecurityError) throw error;
    if (!hadExistingOutput) {
      replaceFileAtomically(resolvedOutputPath, FAILURE_SENTINEL);
    }
    return null;
  }

  try {
    replaceFileAtomically(resolvedOutputPath, combinedCss);
  } catch (error) {
    logger.error?.("CSS build failed", error instanceof Error ? error.message : error);
    throw error;
  }
  logger.success?.(`Built CSS (${processedCount} files, ${Date.now() - startedAt}ms)`);
  if (missingFiles.length > 0) {
    logger.warn?.(`Missing imports: ${missingFiles.join(", ")}`);
  }
  return combinedCss;
}
