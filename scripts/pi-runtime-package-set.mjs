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

    const dependencyNames = Object.keys(packageJson.dependencies || {}).sort();
    for (const dependencyName of dependencyNames) {
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
