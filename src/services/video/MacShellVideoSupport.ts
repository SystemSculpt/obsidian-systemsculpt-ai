export const hasMacWindowShellRecordingSupport = (): boolean => {
  if (typeof process === "undefined" || process.platform !== "darwin") {
    return false;
  }

  const candidates = [
    (globalThis as any)?.require,
    (globalThis as any)?.window?.require,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "function") continue;
    try {
      const childProcess = candidate("child_process") as { spawn?: Function };
      if (typeof childProcess?.spawn === "function") {
        return true;
      }
    } catch {
      // ignore and continue
    }
  }

  return false;
};

