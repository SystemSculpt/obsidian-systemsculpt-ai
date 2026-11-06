import { DEFAULT_DIRS } from "../../../core/settings/defaultDirectories";

const DEFAULT_CHATS_DIRECTORY = DEFAULT_DIRS.chatsDirectory;

/**
 * The configured chats folder without trailing slashes. An empty setting
 * means the default folder, as the settings field promises.
 */
export function resolveChatsDirectory(
  settings: Readonly<{ chatsDirectory?: unknown }>,
): string {
  const configured = typeof settings.chatsDirectory === "string"
    ? settings.chatsDirectory.replace(/\/+$/u, "")
    : "";
  return configured || DEFAULT_CHATS_DIRECTORY;
}

/**
 * Every folder that may hold chat transcripts: the configured one first, then
 * the default and each recorded folder (see `knownChatsDirectories`). Chats
 * stay where they were created when the setting changes, so attachment
 * cleanup and chat lookup must cover all of them.
 */
export function resolveKnownChatsDirectories(
  settings: Readonly<{ chatsDirectory?: unknown; knownChatsDirectories?: unknown }>,
): string[] {
  return [...new Set([
    resolveChatsDirectory(settings),
    ...recordedChatsDirectories(settings),
  ])];
}

/** The default folder and every folder recorded in settings, normalized. */
export function recordedChatsDirectories(
  settings: Readonly<{ knownChatsDirectories?: unknown }>,
): string[] {
  const recorded: unknown[] = Array.isArray(settings.knownChatsDirectories)
    ? settings.knownChatsDirectories
    : [];
  return [
    DEFAULT_CHATS_DIRECTORY,
    ...recorded.map((chatsDirectory) => resolveChatsDirectory({ chatsDirectory })),
  ];
}

/** Folder containment on a path boundary: `Chats-old/x.md` is not in `Chats`. */
export function isPathInDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** A saved chat keeps its folder across settings changes. */
export function isPathInKnownChatsDirectory(
  path: string,
  settings: Readonly<{ chatsDirectory?: unknown; knownChatsDirectories?: unknown }>,
): boolean {
  return resolveKnownChatsDirectories(settings).some(directory => isPathInDirectory(path, directory));
}
