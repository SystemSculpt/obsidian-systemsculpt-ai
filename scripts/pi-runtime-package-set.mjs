import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

export const PI_RUNTIME_ENTRY_PACKAGE = "@mariozechner/pi-coding-agent";

const BUILTIN_MODULE_SET = new Set(
  builtinModules
    .flatMap((name) => {
      const normalized = String(name || "").trim();
      if (!normalized) return [];
      const withoutPrefix = normalized.replace(/^node:/, "");
      return [normalized, withoutPrefix, `node:${withoutPrefix}`];
    })
    .filter(Boolean)
);

function packageNameToPath(packageName) {
  return packageName.split("/");
}

function readPackageJson(packageDir) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Package metadata missing: ${packageJsonPath}`);
  }
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function resolveInstalledPackageDir(packageName, issuerDir, rootDir) {
  const segments = packageNameToPath(packageName);
  const normalizedRoot = path.resolve(rootDir);
  let current = path.resolve(issuerDir);

  while (true) {
    const candidate = path.join(current, "node_modules", ...segments);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }

    if (current === normalizedRoot) {
      break;
    }

    const parent = path.dirname(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }

  const fallback = path.join(normalizedRoot, "node_modules", ...segments);
  if (fs.existsSync(path.join(fallback, "package.json"))) {
    return fallback;
  }

  return null;
}

function shouldSkipDependency(dependencyName) {
  return BUILTIN_MODULE_SET.has(String(dependencyName || "").trim());
}

function normalizePackageSpecifier(specifier) {
  const normalized = String(specifier || "").trim();
  if (!normalized || normalized.startsWith(".") || normalized.startsWith("/") || normalized.startsWith("file:")) {
    return null;
  }
  if (BUILTIN_MODULE_SET.has(normalized)) {
    return null;
  }

  if (normalized.startsWith("@")) {
    const [scope, name] = normalized.split("/");
    return scope && name ? `${scope}/${name}` : null;
  }

  const [name] = normalized.split("/");
  return name || null;
}

function walkRuntimeSourceFiles(basePath, sink) {
  if (!fs.existsSync(basePath)) {
    return;
  }

  const stats = fs.statSync(basePath);
  if (stats.isFile()) {
    if (/\.(?:c|m)?js$/i.test(basePath)) {
      sink.add(basePath);
    }
    return;
  }

  const skipDirectoryNames = new Set([
    ".git",
    ".hg",
    ".svn",
    "coverage",
    "docs",
    "example",
    "examples",
    "node_modules",
    "spec",
    "src",
    "test",
    "tests",
  ]);

  const queue = [basePath];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectoryNames.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }
      if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) {
        sink.add(absolutePath);
      }
    }
  }
}

function addExportTargetPaths(target, packageDir, sink) {
  if (!target) {
    return;
  }

  if (typeof target === "string") {
    if (target.startsWith("./")) {
      walkRuntimeSourceFiles(path.join(packageDir, target), sink);
    }
    return;
  }

  if (Array.isArray(target)) {
    for (const entry of target) {
      addExportTargetPaths(entry, packageDir, sink);
    }
    return;
  }

  if (typeof target === "object") {
    for (const value of Object.values(target)) {
      addExportTargetPaths(value, packageDir, sink);
    }
  }
}

function collectRuntimeSourcePaths(packageDir, packageJson) {
  const sourcePaths = new Set();

  if (fs.existsSync(path.join(packageDir, "dist"))) {
    walkRuntimeSourceFiles(path.join(packageDir, "dist"), sourcePaths);
  }
  if (fs.existsSync(path.join(packageDir, "lib"))) {
    walkRuntimeSourceFiles(path.join(packageDir, "lib"), sourcePaths);
  }

  for (const fieldName of ["main", "module", "browser"]) {
    const fieldValue = packageJson[fieldName];
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      walkRuntimeSourceFiles(path.join(packageDir, fieldValue), sourcePaths);
    }
  }

  const binField = packageJson.bin;
  if (typeof binField === "string" && binField.trim()) {
    walkRuntimeSourceFiles(path.join(packageDir, binField), sourcePaths);
  } else if (binField && typeof binField === "object") {
    for (const candidate of Object.values(binField)) {
      if (typeof candidate === "string" && candidate.trim()) {
        walkRuntimeSourceFiles(path.join(packageDir, candidate), sourcePaths);
      }
    }
  }

  addExportTargetPaths(packageJson.exports, packageDir, sourcePaths);

  if (sourcePaths.size === 0) {
    walkRuntimeSourceFiles(packageDir, sourcePaths);
  }

  return Array.from(sourcePaths.values()).sort();
}

function collectImportedPackageNames(packageDir, packageJson) {
  const importedPackages = new Set();
  const sourcePaths = collectRuntimeSourcePaths(packageDir, packageJson);
  const importPatterns = [
    /\bimport\s*\(\s*["']([^"'`]+)["']\s*\)/g,
    /\brequire\(\s*["']([^"'`]+)["']\s*\)/g,
    /^\s*import\s+(?:[^"'`\n]+?\s+from\s+)?["']([^"'`\n]+)["']/gm,
    /^\s*export\s+[^"'`\n]+?\s+from\s+["']([^"'`\n]+)["']/gm,
  ];

  for (const sourcePath of sourcePaths) {
    const source = fs.readFileSync(sourcePath, "utf8");
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const packageName = normalizePackageSpecifier(match[1]);
        if (!packageName) {
          continue;
        }
        importedPackages.add(packageName);
      }
    }
  }

  return Array.from(importedPackages.values()).sort();
}

function toRelativePackagePath(rootDir, packageDir) {
  const relativePath = path.relative(rootDir, packageDir);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Package ${packageDir} is outside the project root ${rootDir}.`);
  }
  return relativePath.split(path.sep).join("/");
}

function compareByDirectoryDepth(leftPath, rightPath) {
  const leftDepth = leftPath.split(/[\\/]+/).length;
  const rightDepth = rightPath.split(/[\\/]+/).length;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }
  return leftPath.localeCompare(rightPath);
}

function isAncestorPath(ancestorPath, candidatePath) {
  if (!ancestorPath || !candidatePath || ancestorPath === candidatePath) {
    return false;
  }
  const normalizedAncestor = ancestorPath.endsWith("/") ? ancestorPath : `${ancestorPath}/`;
  return candidatePath.startsWith(normalizedAncestor);
}

export function collectPiRuntimePackages(options = {}) {
  const rootDir = path.resolve(String(options.rootDir || process.cwd()));
  const entryPackageName = String(options.entryPackageName || PI_RUNTIME_ENTRY_PACKAGE).trim();
  const entryPackageDir = resolveInstalledPackageDir(entryPackageName, rootDir, rootDir);
  if (!entryPackageDir) {
    throw new Error(
      `Pi runtime entry package ${entryPackageName} is unavailable under ${path.join(rootDir, "node_modules")}. Run npm install first.`
    );
  }

  const queue = [entryPackageDir];
  const seenDirs = new Set();
  const packages = [];

  while (queue.length > 0) {
    const packageDir = queue.shift();
    const normalizedDir = path.resolve(packageDir);
    if (seenDirs.has(normalizedDir)) {
      continue;
    }
    seenDirs.add(normalizedDir);

    const packageJson = readPackageJson(normalizedDir);
    const packageName = String(packageJson.name || "").trim();
    if (!packageName) {
      throw new Error(`Package at ${normalizedDir} is missing a name.`);
    }

    packages.push({
      name: packageName,
      dir: normalizedDir,
      relativePath: toRelativePackagePath(rootDir, normalizedDir),
      packageJson,
    });

    const declaredDependencyNames = new Set(Object.keys(packageJson.dependencies || {}));
    const importedDependencyNames = new Set(collectImportedPackageNames(normalizedDir, packageJson));
    declaredDependencyNames.delete(packageName);
    importedDependencyNames.delete(packageName);

    for (const dependencyName of Array.from(declaredDependencyNames.values()).sort()) {
      if (shouldSkipDependency(dependencyName)) {
        continue;
      }

      const dependencyDir = resolveInstalledPackageDir(dependencyName, normalizedDir, rootDir);
      if (!dependencyDir) {
        throw new Error(
          `Required Pi runtime dependency ${dependencyName} was not found while scanning ${packageName}.`
        );
      }
      queue.push(dependencyDir);
    }

    for (const dependencyName of Array.from(importedDependencyNames.values()).sort()) {
      if (shouldSkipDependency(dependencyName) || declaredDependencyNames.has(dependencyName)) {
        continue;
      }

      const dependencyDir = resolveInstalledPackageDir(dependencyName, normalizedDir, rootDir);
      if (dependencyDir) {
        queue.push(dependencyDir);
      }
    }
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export function getPiRuntimePackageNames(options = {}) {
  return collectPiRuntimePackages(options).map((entry) => entry.name);
}

export function collectPiRuntimePackageRoots(options = {}) {
  const packages = collectPiRuntimePackages(options).sort((left, right) =>
    compareByDirectoryDepth(left.relativePath, right.relativePath)
  );
  const roots = [];

  for (const entry of packages) {
    if (roots.some((rootEntry) => isAncestorPath(rootEntry.relativePath, entry.relativePath))) {
      continue;
    }
    roots.push(entry);
  }

  return roots;
}
