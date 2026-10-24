import fs from "node:fs";
import path from "node:path";
import esbuild from "esbuild";
import { replaceFileAtomically } from "./platform-portability.mjs";

const FAILURE_SENTINEL = "/* CSS build failed */\n";

class CssBuildSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CssBuildSecurityError";
  }
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
  return fs.realpathSync(sourceRoot);
}

function resolveCssImport(sourceRoot, importPath, resolveDir) {
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

  const resolvedPath = path.resolve(resolveDir, normalizedImportPath);
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
  if (escapesRoot(sourceRoot, realPath)) {
    throw new CssBuildSecurityError(
      `CSS import must resolve to a regular file inside the CSS source root: ${importPath}`,
    );
  }
  return resolvedPath;
}

export async function buildCssArtifact({
  indexPath,
  outputPath,
  production = true,
  logger = console,
} = {}) {
  const resolvedIndexPath = path.resolve(String(indexPath || ""));
  const resolvedOutputPath = path.resolve(String(outputPath || ""));
  const hadExistingOutput = assertSafeOutputPath(resolvedOutputPath);
  const startedAt = Date.now();
  let result;

  try {
    if (!fs.existsSync(resolvedIndexPath)) {
      throw new Error(`CSS entry file missing at ${resolvedIndexPath}`);
    }

    const sourceRoot = inspectCssSourceRoot(resolvedIndexPath);
    result = await esbuild.build({
      absWorkingDir: sourceRoot,
      entryPoints: [resolvedIndexPath],
      outfile: resolvedOutputPath,
      bundle: true,
      minify: production,
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [{
        name: "css-source-paths",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            // Preserve asset URLs as authored, as the concatenator did. Only
            // stylesheets are build inputs; URLs must not read/embed local files.
            if (args.kind === "url-token") return { path: args.path, external: true };
            if (args.kind !== "import-rule") return;
            const resolvedPath = resolveCssImport(sourceRoot, args.path, args.resolveDir);
            if (!resolvedPath) throw new Error(`Missing CSS imports: ${args.path}`);
            return { path: resolvedPath };
          });
        },
      }],
    });
  } catch (error) {
    logger.error?.("CSS build failed", error instanceof Error ? error.message : error);
    const securityError = error instanceof CssBuildSecurityError
      || error?.errors?.some((entry) => entry.detail instanceof CssBuildSecurityError);
    if (production || securityError) throw error;
    if (!hadExistingOutput) {
      replaceFileAtomically(resolvedOutputPath, FAILURE_SENTINEL);
    }
    return null;
  }

  const css = result.outputFiles[0].text;
  try {
    assertSafeOutputPath(resolvedOutputPath);
    replaceFileAtomically(resolvedOutputPath, css);
  } catch (error) {
    logger.error?.("CSS build failed", error instanceof Error ? error.message : error);
    throw error;
  }
  for (const warning of result.warnings) logger.warn?.(warning.text);
  logger.success?.(`Built CSS (${Object.keys(result.metafile.inputs).length} files, ${Date.now() - startedAt}ms)`);
  return css;
}
