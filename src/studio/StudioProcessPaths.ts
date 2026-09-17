/** Directory part of an absolute OS path, for either separator style. */
export function dirnameOfAbsolutePath(absolutePath: string): string {
  const value = String(absolutePath || '')
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (index <= 0) return value.startsWith('/') ? '/' : value
  return value.slice(0, index)
}

export function isAbsoluteOsPath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Joins OS path segments using the separator style of the base path. */
export function joinOsPath(base: string, ...segments: string[]): string {
  const separator = /^[a-zA-Z]:\\|^\\\\/.test(base) ? '\\' : '/'
  const trimmedBase = base.replace(/[\\/]+$/, '')
  const rest = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, '')).filter(Boolean)
  return [trimmedBase, ...rest].join(separator)
}

/** Resolves a path-shaped executable from its configured working directory. */
export function resolveExecutableCandidate(executable: string, workingDirectory: string): string {
  return !isAbsoluteOsPath(executable) && /[\\/]/.test(executable)
    ? joinOsPath(workingDirectory, executable)
    : executable
}

