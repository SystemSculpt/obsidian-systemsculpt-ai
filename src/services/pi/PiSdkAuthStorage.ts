import {
  AuthStorage,
  type ApiKeyCredential,
  type AuthCredential,
  type AuthStorageBackend,
  type OAuthCredential,
} from "@mariozechner/pi-coding-agent";

export type {
  ApiKeyCredential,
  AuthCredential,
  AuthStorageBackend,
  OAuthCredential,
};

export type PiAuthStorageInstance = AuthStorage;

/**
 * Create an AuthStorage instance for the given auth.json path.
 *
 * The SDK's FileAuthStorageBackend uses proper-lockfile for thread-safe I/O,
 * but proper-lockfile can fail silently in Obsidian's Electron renderer.
 * When the file-backed storage fails to load, fall back to an in-memory
 * AuthStorage seeded with a direct fs.readFileSync of auth.json. This
 * sacrifices write-back (credentials won't persist from in-memory storage)
 * but ensures model discovery and auth checks work correctly.
 */
export const createBundledPiAuthStorage = (
  authPath?: string,
): PiAuthStorageInstance => {
  const storage = AuthStorage.create(authPath);

  // Check if the file-backed storage loaded successfully. The SDK's
  // FileAuthStorageBackend uses proper-lockfile which can fail silently
  // in Electron's renderer. If drainErrors() reports errors and getAll()
  // is empty, the lockfile-wrapped reload likely failed.
  const hasErrors =
    typeof storage.drainErrors === "function" && storage.drainErrors().length > 0;
  const hasData = Object.keys(storage.getAll()).length > 0;

  if (!hasErrors || hasData) {
    return storage;
  }

  // File-backed storage failed (likely proper-lockfile issue in Electron).
  // Fall back to in-memory storage seeded with a direct fs.readFileSync of
  // auth.json. This sacrifices write-back but ensures model discovery and
  // auth checks work correctly.
  if (authPath) {
    try {
      const fs = require("fs");
      if (fs.existsSync(authPath)) {
        const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        if (data && typeof data === "object" && !Array.isArray(data)) {
          return AuthStorage.inMemory(data);
        }
      }
    } catch {
      // Direct read also failed — return the original (empty) storage.
    }
  }

  return storage;
};
