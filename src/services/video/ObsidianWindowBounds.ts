import type { ExecFileSyncFn } from "./MacShellRuntime";

export interface ObsidianWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ObsidianWindowBoundsProbeResult =
  | {
    state: "available";
    bounds: ObsidianWindowBounds;
  }
  | {
    state: "unavailable";
    reason: "runtime-missing" | "not-open" | "automation-denied" | "too-small" | "unknown";
    detail: string;
  };

const MIN_WINDOW_CAPTURE_WIDTH = 64;
const MIN_WINDOW_CAPTURE_HEIGHT = 64;
const FRONT_WINDOW_BOUNDS_SCRIPT =
  'tell application "System Events" to tell process "Obsidian" to return (position of front window) & (size of front window)';

const normalizeBoundsOutput = (output: string | Buffer): number[] => {
  const text = (typeof output === "string" ? output : output.toString("utf8")).trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[^0-9\-]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => Number(entry));
};

export const parseObsidianWindowBounds = (output: string | Buffer): ObsidianWindowBounds | null => {
  const numbers = normalizeBoundsOutput(output);
  if (numbers.length < 4 || numbers.slice(0, 4).some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    x: Math.round(numbers[0]),
    y: Math.round(numbers[1]),
    width: Math.round(numbers[2]),
    height: Math.round(numbers[3]),
  };
};

const isAutomationDeniedError = (message: string): boolean => {
  return message.includes("not authorized to send apple events")
    || message.includes("not permitted")
    || message.includes("access is not allowed");
};

const isWindowNotFoundError = (message: string): boolean => {
  return message.includes("can't get process")
    || message.includes("can’t get process")
    || message.includes("can't get window")
    || message.includes("can’t get window")
    || message.includes("isn't running");
};

export const probeObsidianFrontWindowBounds = (
  execFileSync: ExecFileSyncFn | null
): ObsidianWindowBoundsProbeResult => {
  if (!execFileSync) {
    return {
      state: "unavailable",
      reason: "runtime-missing",
      detail: "Unable to verify Obsidian-window targeting in this runtime.",
    };
  }

  try {
    const output = execFileSync(
      "osascript",
      ["-e", FRONT_WINDOW_BOUNDS_SCRIPT],
      { encoding: "utf8", timeout: 1200 }
    );

    const parsed = parseObsidianWindowBounds(output);
    if (!parsed) {
      return {
        state: "unavailable",
        reason: "not-open",
        detail: "Open an Obsidian desktop window, then try again.",
      };
    }

    if (parsed.width < MIN_WINDOW_CAPTURE_WIDTH || parsed.height < MIN_WINDOW_CAPTURE_HEIGHT) {
      return {
        state: "unavailable",
        reason: "too-small",
        detail: "Obsidian window appears too small for reliable capture. Expand it and try again.",
      };
    }

    return {
      state: "available",
      bounds: parsed,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
    if (isAutomationDeniedError(message)) {
      return {
        state: "unavailable",
        reason: "automation-denied",
        detail: "Allow automation access to System Events for direct Obsidian-window targeting.",
      };
    }

    if (isWindowNotFoundError(message)) {
      return {
        state: "unavailable",
        reason: "not-open",
        detail: "Obsidian window was not found. Open Obsidian and keep it visible.",
      };
    }

    return {
      state: "unavailable",
      reason: "unknown",
      detail: `Could not verify Obsidian-window targeting: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
