/** Lexical only: native-requested paths are never resolved through the filesystem. */
export function normalizedNativePath(path: string): string {
  const slashPath = path.replace(/\\/gu, "/");
  const root = /^[A-Za-z]:\//u.exec(slashPath)?.[0]
    ?? (slashPath.startsWith("//") ? "//" : slashPath.startsWith("/") ? "/" : "");
  const segments: string[] = [];
  for (const segment of slashPath.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length && segments[segments.length - 1] !== "..") segments.pop();
    else if (segment === ".." && root) continue;
    else segments.push(segment);
  }
  return root + segments.join("/");
}

// Windows drive letters are case-insensitive; preserve the requested spelling.
export function comparableNativePath(value: string): string {
  return /^[A-Za-z]:/u.test(value) ? value[0].toLowerCase() + value.slice(1) : value;
}

export function isAbsoluteNativePath(value: string): boolean {
  return /^(?:[/\\]|[A-Za-z]:[/\\])/u.test(value);
}

/** Resolve against the request cwd, but display relative only to Chat's vault roots. */
export function nativeToolPath(path: string, workingDirectory: string, vaultRoot = workingDirectory, vaultRootAlias?: string, homeDirectory?: string): { displayPath: string; vaultPath: string | null } {
  // Saved native activity has a portable root, not authority to read local files.
  if (vaultRoot === "." && !isAbsoluteNativePath(workingDirectory)
    && path && !path.includes("\0") && !/^~(?:\/|\\|$)/u.test(path)) {
    const relative = normalizedNativePath(isAbsoluteNativePath(path) ? path : `${workingDirectory}/${path}`);
    if (!isAbsoluteNativePath(relative) && relative !== ".." && !relative.startsWith("../")) {
      return { displayPath: relative || "Vault root", vaultPath: relative || null };
    }
    return { displayPath: `${relative} (outside vault)`, vaultPath: null };
  }
  if (!path || path.includes("\0") || !isAbsoluteNativePath(vaultRoot) || (!isAbsoluteNativePath(path) && !isAbsoluteNativePath(workingDirectory)) || /^~(?:\/|\\|$)/u.test(path)) {
    return { displayPath: `${path} (vault location unverified)`, vaultPath: null };
  }
  const target = normalizedNativePath(isAbsoluteNativePath(path) ? path : `${workingDirectory}/${path}`);
  for (const value of [vaultRoot, vaultRootAlias]) {
    if (!value || !isAbsoluteNativePath(value)) continue;
    const root = normalizedNativePath(value);
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const relative = comparableNativePath(target) === comparableNativePath(root) ? ""
      : comparableNativePath(target).startsWith(comparableNativePath(prefix)) ? target.slice(prefix.length) : null;
    if (relative !== null) return { displayPath: relative === "" ? "Vault root" : relative, vaultPath: relative || null };
  }
  const home = homeDirectory && isAbsoluteNativePath(homeDirectory) ? normalizedNativePath(homeDirectory).replace(/\/$/u, "") : undefined;
  const fromHome = home && comparableNativePath(target).startsWith(comparableNativePath(`${home}/`)) ? `~/${target.slice(home.length + 1)}` : target;
  return { displayPath: `${fromHome} (outside vault)`, vaultPath: null };
}

const NATIVE_ROOT_ONLY = /^(?:[A-Za-z]:\/|\/\/?)$/u;

/**
 * Rewrite absolute directory prefixes in free text (native tool output,
 * commands, messages) to portable spellings, longest directory first. A prefix
 * matches only as a whole path: where a path can start, and followed by a
 * separator, a line break, a quote or the end of the text. A sibling such as
 * "Vault 2" never reads as "Vault", and a prefix inside another path stays.
 */
export function nativePathPrefixRewriter(prefixes: Iterable<readonly [directory: string, replacement: string]>): (text: string) => string {
  const replacements = new Map<string, { directory: string; replacement: string }>();
  for (const [value, replacement] of prefixes) {
    if (!isAbsoluteNativePath(value) || value.includes("\0")) continue;
    const directory = normalizedNativePath(value);
    const key = comparableNativePath(directory);
    if (!NATIVE_ROOT_ONLY.test(directory) && !replacements.has(key)) replacements.set(key, { directory, replacement });
  }
  if (!replacements.size) return (text) => text;
  const patterns = [...replacements.values()].sort((a, b) => b.directory.length - a.directory.length)
    .map(({ directory }) => /^[A-Za-z]:|^\/\//u.test(directory)
      ? [...directory].map((character, index) => character === "/" ? "[\\\\/]"
        : index === 0 && /[A-Za-z]/u.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]`
          : character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("")
      : directory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = new RegExp(`(^|[\\s"'\`=:(\\[{<>,;|&])(${patterns.join("|")})(?=[\\\\/\\r\\n\\t"'\`]|$)`, "gu");
  return (text) => text.replace(pattern, (match: string, before: string, directory: string) => {
    const replacement = replacements.get(comparableNativePath(normalizedNativePath(directory)))?.replacement;
    return replacement === undefined ? match : before + replacement;
  });
}
