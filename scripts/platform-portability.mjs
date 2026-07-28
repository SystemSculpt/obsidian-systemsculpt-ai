export function toRepositoryPath(value) {
  return value.replace(/\\/g, "/");
}

export function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function npmExecutable(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}
