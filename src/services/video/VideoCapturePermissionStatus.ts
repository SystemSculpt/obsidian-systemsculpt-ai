import {
  resolveElectronFromRuntime,
  resolveExecFileSyncFromRuntime,
} from "./MacShellRuntime";
import { probeObsidianFrontWindowBounds } from "./ObsidianWindowBounds";

type PermissionState = "done" | "needs-action" | "unknown";

export interface VideoCapturePermissionStatus {
  screenAndSystemAudio: {
    state: PermissionState;
    detail: string;
  };
  directWindowAccess: {
    state: PermissionState;
    detail: string;
  };
}

type ElectronSystemPreferencesLike = {
  getMediaAccessStatus?: (mediaType: string) => string;
};

const detectScreenAndSystemAudioStatus = (
  systemPreferences: ElectronSystemPreferencesLike | undefined
): VideoCapturePermissionStatus["screenAndSystemAudio"] => {
  if (!systemPreferences?.getMediaAccessStatus) {
    return {
      state: "unknown",
      detail: "Unable to verify in this Obsidian runtime.",
    };
  }

  const raw = String(systemPreferences.getMediaAccessStatus("screen") || "").toLowerCase();

  if (raw === "granted") {
    return {
      state: "done",
      detail: "macOS reports screen/system-audio capture permission is granted.",
    };
  }

  if (raw === "denied" || raw === "restricted") {
    return {
      state: "needs-action",
      detail: "macOS reports access is denied or restricted.",
    };
  }

  if (raw === "not-determined") {
    return {
      state: "needs-action",
      detail: "Permission has not been granted yet.",
    };
  }

  return {
    state: "unknown",
    detail: raw ? `macOS returned status: ${raw}` : "macOS permission status is unavailable.",
  };
};

const detectDirectWindowAccessStatus = (
  execFileSync: ReturnType<typeof resolveExecFileSyncFromRuntime>
): VideoCapturePermissionStatus["directWindowAccess"] => {
  const boundsProbe = probeObsidianFrontWindowBounds(execFileSync);
  if (boundsProbe.state === "available") {
    return {
      state: "done",
      detail: "Obsidian-window targeting is available.",
    };
  }

  switch (boundsProbe.reason) {
    case "automation-denied":
    case "not-open":
    case "too-small":
      return {
        state: "needs-action",
        detail: boundsProbe.detail,
      };
    case "runtime-missing":
      return {
        state: "unknown",
        detail: boundsProbe.detail,
      };
    default:
      return {
        state: "unknown",
        detail: boundsProbe.detail,
      };
  }
};

export const getVideoCapturePermissionStatus = async (): Promise<VideoCapturePermissionStatus> => {
  const electron = resolveElectronFromRuntime<ElectronSystemPreferencesLike>();
  const execFileSync = resolveExecFileSyncFromRuntime();

  return {
    screenAndSystemAudio: detectScreenAndSystemAudioStatus(electron?.systemPreferences),
    directWindowAccess: detectDirectWindowAccessStatus(execFileSync),
  };
};
