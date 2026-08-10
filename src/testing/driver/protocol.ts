/**
 * SystemSculptTestDriver/v1
 *
 * Wire protocol shared by the in-plugin E2E test driver and the external
 * `npm run e2e` CLI. The CLI hosts a localhost WebSocket server and writes a
 * handshake file into the plugin's config directory; the driver (present only
 * in non-release builds) polls for that file and dials out. The plugin never
 * opens a listening socket.
 */

export const TEST_DRIVER_MARKER = "SystemSculptTestDriver/v1";

export const TEST_DRIVER_PROTOCOL_VERSION = 1;

/** Handshake file name inside `<configDir>/plugins/<plugin-id>/`. */
export const TEST_DRIVER_HANDSHAKE_FILE = "e2e-driver.json";

/** How often the driver looks for a fresh handshake file. */
export const TEST_DRIVER_POLL_INTERVAL_MS = 1000;

/** Handshake files older than this are ignored as stale. */
export const TEST_DRIVER_HANDSHAKE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface TestDriverHandshake {
  version: number;
  serverId: string;
  port: number;
  token: string;
  createdAt: string;
}

export interface TestDriverHello {
  type: "hello";
  token: string;
  serverId: string;
  marker: typeof TEST_DRIVER_MARKER;
  artifactId: string;
  vault: string;
  pluginVersion: string;
  buildStamp: string;
  apiBaseUrl: string;
}

export interface TestDriverActionRequest {
  type: "action";
  id: number;
  action: string;
  params?: Record<string, unknown>;
}

export interface TestDriverActionCancel {
  type: "cancel";
  id: number;
}

export type TestDriverClientMessage =
  | TestDriverActionRequest
  | TestDriverActionCancel;

export interface TestDriverActionResult {
  type: "result";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export function parseTestDriverClientMessage(
  raw: string,
): TestDriverClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.type === "cancel" && typeof value.id === "number") {
    return { type: "cancel", id: value.id };
  }
  if (
    value.type !== "action"
    || typeof value.id !== "number"
    || typeof value.action !== "string"
  ) return null;
  return {
    type: "action",
    id: value.id,
    action: value.action,
    params: typeof value.params === "object"
      && value.params !== null
      && !Array.isArray(value.params)
      ? value.params as Record<string, unknown>
      : {},
  };
}

export function parseHandshake(raw: string): TestDriverHandshake | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== TEST_DRIVER_PROTOCOL_VERSION) return null;
  if (typeof value.serverId !== "string" || value.serverId.length === 0) return null;
  if (typeof value.port !== "number" || !Number.isInteger(value.port)) return null;
  if (value.port <= 0 || value.port > 65535) return null;
  if (typeof value.token !== "string" || value.token.length === 0) return null;
  if (typeof value.createdAt !== "string") return null;
  const createdAtMs = Date.parse(value.createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  if (Date.now() - createdAtMs > TEST_DRIVER_HANDSHAKE_MAX_AGE_MS) return null;
  return {
    version: TEST_DRIVER_PROTOCOL_VERSION,
    serverId: value.serverId,
    port: value.port,
    token: value.token,
    createdAt: value.createdAt,
  };
}
